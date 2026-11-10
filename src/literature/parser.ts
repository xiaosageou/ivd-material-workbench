import path from 'node:path';
import { parseResearchFile, type ParseResult } from '../ai/parsers.ts';

export const LITERATURE_PARSER_VERSION = 'literature-parser-2';
export const LITERATURE_CHUNKER_VERSION = 'literature-chunker-2';
export const LITERATURE_MAX_TEXT_CHARS = 2_000_000;
export const LITERATURE_MAX_PDF_PAGES = 1_500;
export const LITERATURE_CHUNK_CHARS = 1_100;
export const LITERATURE_CHUNK_OVERLAP = 160;

export type LiteratureParsedChunk = { locator: Record<string, unknown>; sectionTitle: string; text: string };
export type LiteratureParseResult = {
  status: 'parsed' | 'partial' | 'needs_ocr' | 'unsupported';
  format: string;
  chunks: LiteratureParsedChunk[];
  pageCount: number;
  pagesRead: number;
  textLength: number;
  coverage: Record<string, unknown>;
};

function splitText(text: string, locator: Record<string, unknown>, sectionTitle: string): LiteratureParsedChunk[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[\t\u00a0]+/g, ' ').trim();
  if (!normalized) return [];
  const result: LiteratureParsedChunk[] = [];
  let start = 0;
  let sequence = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + LITERATURE_CHUNK_CHARS);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(LITERATURE_CHUNK_CHARS * .62)) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) result.push({ locator: { ...locator, characterStart: start, characterEnd: end, segment: sequence + 1 }, sectionTitle, text: chunk });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - LITERATURE_CHUNK_OVERLAP);
    sequence++;
  }
  return result;
}

function parseText(buffer: Buffer, extension: string): LiteratureParseResult {
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const text = decoded.replace(/^\uFEFF/, '');
  const wasTruncated = text.length > LITERATURE_MAX_TEXT_CHARS;
  const body = text.slice(0, LITERATURE_MAX_TEXT_CHARS);
  const blocks = body.split(/\n\s*\n/g);
  const chunks: LiteratureParsedChunk[] = [];
  let offset = 0;
  let paragraph = 0;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) { offset += block.length + 2; continue; }
    const isHeading = extension === '.md' && /^#{1,6}\s+/.test(trimmed);
    const title = isHeading ? trimmed.replace(/^#{1,6}\s+/, '').slice(0, 180) : '';
    chunks.push(...splitText(trimmed, { kind: 'text_block', paragraph: paragraph + 1, characterStart: offset }, title));
    paragraph++;
    offset += block.length + 2;
  }
  return { status: wasTruncated ? 'partial' : 'parsed', format: extension.slice(1), chunks, pageCount: 0, pagesRead: 0,
    textLength: body.length, coverage: { encoding: 'UTF-8 (invalid byte replacement may occur)', paragraphs: paragraph,
      sourceCharacters: text.length, extractedCharacters: body.length, omittedReason: wasTruncated ? '文本达到 2,000,000 字符上限' : null,
      comments: extension === '.md' ? 'Markdown 标题作为段落定位；表格按原文本保留。' : '纯文本按空行分段。' } };
}

async function parseDocx(buffer: Buffer): Promise<LiteratureParseResult> {
  const parsed = await parseResearchFile('literature.docx', buffer);
  const chunks = parsed.chunks.flatMap(chunk => splitText(chunk.text, chunk.locator, String(chunk.locator.kind || '正文')));
  const partial = parsed.status === 'partial';
  return { status: partial ? 'partial' : 'parsed', format: 'docx', chunks, pageCount: 0, pagesRead: 0,
    textLength: parsed.textLength, coverage: { ...parsed.coverage, parser: 'docx-safe-xml', pageNumbers: 'unavailable_without_rendering',
      comments: '读取 DOCX 正文段落和表格，不运行宏；未渲染版式，页码不可用。' } };
}

export async function parsePdfDocument(document: any, shouldCancel: () => boolean = () => false): Promise<LiteratureParseResult> {
  const chunks: LiteratureParsedChunk[] = [];
  let textLength = 0;
  let pagesRead = 0;
  const errors: Array<{ page: number; error: string }> = [];
  const pagesWithoutText: number[] = [];
  let truncated = false;
  const pageCount = Number(document.numPages || 0);
  if (pageCount < 1) throw new Error('PDF 不含可读取页面');
  const pageLimit = Math.min(pageCount, LITERATURE_MAX_PDF_PAGES);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
    if (shouldCancel()) throw Object.assign(new Error('文献解析任务已取消'), { code: 'CANCELLED' });
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const items = (content.items as any[]).filter(item => typeof item.str === 'string');
      const text = items.map(item => `${item.str}${item.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+\n/g, '\n').trim();
      if (text) {
        const remaining = LITERATURE_MAX_TEXT_CHARS - textLength;
        if (remaining <= 0) { truncated = true; break; }
        const body = text.length > remaining ? text.slice(0, remaining) : text;
        chunks.push(...splitText(body, { kind: 'pdf_page', page: pageNumber, pageCount }, `PDF 第 ${pageNumber} 页`));
        textLength += body.length;
        if (body.length < text.length) { truncated = true; break; }
      } else pagesWithoutText.push(pageNumber);
      pagesRead++;
      page.cleanup?.();
    } catch (error) {
      errors.push({ page: pageNumber, error: (error as Error).message.slice(0, 300) });
    }
  }
  const pageLimitHit = pageCount > pageLimit;
  const pagesWithText = chunks.reduce((count, chunk) => count + (chunk.locator.characterStart === 0 ? 1 : 0), 0);
  const noText = textLength === 0;
  const partial = errors.length > 0 || pageLimitHit || truncated || pagesRead < pageCount || (textLength > 0 && pagesWithoutText.length > 0);
  const hasCoverageGap = pagesWithoutText.length > 0;
  const reasons = [
    noText ? 'PDF 没有可提取文本层，需要 OCR' : '',
    hasCoverageGap ? `第 ${pagesWithoutText.join('、')} 页没有可提取文本层；可能为空白页或扫描页，内容未识别` : '',
    truncated ? '达到文本提取上限' : '',
    pageLimitHit ? '达到 PDF 最大页数上限' : '',
    errors.length ? '部分页面解析失败' : '',
  ].filter(Boolean);
  return { status: noText ? 'needs_ocr' : partial ? 'partial' : 'parsed', format: 'pdf', chunks, pageCount, pagesRead,
    textLength, coverage: { textLayerPages: pagesWithText, pagesWithText: Math.min(pagesWithText, pagesRead),
      pagesWithoutTextEstimate: pagesWithoutText.length, pagesWithoutText, pagesFailed: errors.map(row => row.page),
      failedPages: errors, pagesLimit: LITERATURE_MAX_PDF_PAGES, textLimitChars: LITERATURE_MAX_TEXT_CHARS,
      omittedReason: reasons.length ? reasons.join('；') : null,
      ocr: { configured: false, used: false }, comments: '保留物理页码；PDF.js 提取文本层，不执行嵌入 JavaScript，不调用 OCR。无文本层的页面会明确列出，不能据此区分空白页与扫描页。' } };
}

async function parsePdf(buffer: Buffer, shouldCancel: () => boolean): Promise<LiteratureParseResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as any;
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false,
    stopAtErrors: false, disableFontFace: true, verbosity: 0 });
  try { return await parsePdfDocument(await loadingTask.promise, shouldCancel); }
  finally { await loadingTask.destroy().catch(() => undefined); }
}

export async function parseLiteratureFile(fileName: string, buffer: Buffer, shouldCancel: () => boolean = () => false): Promise<LiteratureParseResult> {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.pdf') return parsePdf(buffer, shouldCancel);
  if (extension === '.docx') return parseDocx(buffer);
  if (extension === '.txt' || extension === '.md') return parseText(buffer, extension);
  return { status: 'unsupported', format: extension.slice(1), chunks: [], pageCount: 0, pagesRead: 0, textLength: 0,
    coverage: { parsed: false, reason: '当前文献解析仅支持 PDF、DOCX、TXT、Markdown。', ocr: { configured: false, used: false } } };
}

export function parserResultFromResearch(parsed: ParseResult): LiteratureParseResult {
  return { status: parsed.status === 'partial' ? 'partial' : parsed.status === 'unsupported' ? 'unsupported' : 'parsed',
    format: parsed.format, chunks: parsed.chunks.flatMap(chunk => splitText(chunk.text, chunk.locator, String(chunk.locator.kind || '正文'))),
    pageCount: 0, pagesRead: 0, textLength: parsed.textLength, coverage: parsed.coverage };
}
