import { createHash } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import * as unzipper from 'unzipper';

export const PARSER_VERSION = '2';
export const MAX_EXPANDED_ZIP_BYTES = 50 * 1024 * 1024;
export const MAX_PARSED_ROWS = 20_000;
export const MAX_PARSED_CELLS = 100_000;
export const MAX_EXTRACTED_CHARS = 350_000;
const MAX_ZIP_ENTRIES = 10_000;

export type ParsedChunk = { locator: Record<string, unknown>; text: string };
export type DatasetColumn = { key: string; label: string; unit?: string };
export type ParsedDataset = {
  name: string;
  columns: DatasetColumn[];
  rows: Array<Record<string, string | number | null>>;
  rowStart: number;
  rowEnd: number;
  hidden?: boolean;
};
export type ParseResult = {
  status: 'parsed' | 'partial' | 'unsupported';
  format: string;
  chunks: ParsedChunk[];
  datasets: ParsedDataset[];
  coverage: Record<string, unknown>;
  textLength: number;
};

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const datasetColumn = (key: string, label: string): DatasetColumn => {
  const match = label.trim().match(/^(.*?)\s*[\[(（]([^\])）]+)[\])）]\s*$/);
  return match ? { key, label: match[1].trim() || key, unit: match[2].trim() } : { key, label: label.trim() || key };
};
const decodeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_full, entity: string) => {
  if (entity[0] === '#') {
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] || '';
});

async function checkedZip(buffer: Buffer) {
  const archive = await unzipper.Open.buffer(buffer);
  if (archive.files.length > MAX_ZIP_ENTRIES) throw new Error('Office 文件成员数量超出解析上限');
  let expanded = 0;
  for (const entry of archive.files) {
    if (entry.path.startsWith('/') || entry.path.split(/[\\/]/).includes('..')) throw new Error('Office 文件包含无效压缩路径');
    expanded += Number(entry.uncompressedSize || 0);
    if (expanded > MAX_EXPANDED_ZIP_BYTES) throw new Error('Office 文件展开大小超出解析上限');
  }
  return archive;
}

function wordParagraphText(xml: string) {
  const pieces = [...xml.matchAll(/<(?:w:t|w:delText)(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:t|w:delText)>/g)]
    .map(match => decodeXml(match[1]).replace(/\u00a0/g, ' '));
  return pieces.join('').replace(/\s+/g, ' ').trim();
}

async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const archive = await checkedZip(buffer);
  const entry = archive.files.find(file => file.path === 'word/document.xml');
  if (!entry) throw new Error('DOCX 缺少 word/document.xml');
  if (entry.uncompressedSize > 20 * 1024 * 1024) throw new Error('DOCX 正文 XML 超出解析上限');
  const xml = (await entry.buffer()).toString('utf8');
  const chunks: ParsedChunk[] = [];
  let paragraph = 0;
  let tableIndex = 0;
  let tableDepth = 0;
  let tableRow = -1;
  let tableCell = -1;
  let paragraphStart = -1;
  let textLength = 0;
  const token = /<(\/?)w:(tbl|tr|tc|p)\b[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml)) && textLength < MAX_EXTRACTED_CHARS) {
    const closing = match[1] === '/';
    const tag = match[2];
    if (!closing && tag === 'tbl') {
      if (tableDepth === 0) tableIndex++;
      tableDepth++;
      tableRow = -1;
      tableCell = -1;
    } else if (closing && tag === 'tbl') {
      tableDepth = Math.max(0, tableDepth - 1);
    } else if (!closing && tag === 'tr' && tableDepth > 0) {
      tableRow++;
      tableCell = -1;
    } else if (!closing && tag === 'tc' && tableDepth > 0) {
      tableCell++;
    } else if (!closing && tag === 'p') {
      paragraphStart = token.lastIndex;
    } else if (closing && tag === 'p' && paragraphStart >= 0) {
      const raw = xml.slice(paragraphStart, match.index);
      const text = wordParagraphText(raw);
      const currentParagraph = paragraph++;
      paragraphStart = -1;
      if (!text) continue;
      const locator = tableDepth > 0
        ? { kind: 'table_paragraph', paragraph: currentParagraph, table: tableIndex, row: tableRow + 1, column: tableCell + 1 }
        : { kind: 'paragraph', paragraph: currentParagraph };
      chunks.push({ locator, text });
      textLength += text.length;
    }
  }
  const totalParagraphs = [...xml.matchAll(/<w:p\b/g)].length;
  const totalTables = [...xml.matchAll(/<w:tbl\b/g)].length;
  const partial = textLength >= MAX_EXTRACTED_CHARS || paragraph < totalParagraphs;
  return { status: partial ? 'partial' : 'parsed', format: 'docx', chunks,
    datasets: [], textLength,
    coverage: { paragraphsSeen: paragraph, paragraphsInDocument: totalParagraphs, tablesSeen: tableIndex, tablesInDocument: totalTables,
      omittedReason: partial ? '字符数达到解析上限' : null, comments: '页码未经渲染确认，未生成页码定位。' } };
}

const cellValue = (value: ExcelJS.CellValue): string | number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  if ('result' in value) return (value.result as string | number | null | undefined) ?? null;
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  return '[对象值未展开]';
};

async function parseXlsx(buffer: Buffer): Promise<ParseResult> {
  const archive = await checkedZip(buffer);
  if (!archive.files.some(file => file.path === 'xl/workbook.xml')) throw new Error('XLSX 缺少工作簿目录');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const chunks: ParsedChunk[] = [];
  const datasets: ParsedDataset[] = [];
  let rowsRead = 0;
  let cellsRead = 0;
  let textLength = 0;
  let partial = false;
  const sheetCoverage: Array<Record<string, unknown>> = [];
  for (const sheet of workbook.worksheets) {
    const hidden = sheet.state !== 'visible';
    const rowCountDeclared = sheet.rowCount;
    const colCountDeclared = sheet.columnCount;
    const rowTexts: string[] = [];
    const values: Array<Record<string, string | number | null>> = [];
    const firstRow: string[] = [];
    let rowStart = 1;
    let rowEnd = 0;
    sheet.eachRow({ includeEmpty: false }, row => {
      if (partial || rowsRead >= MAX_PARSED_ROWS || cellsRead >= MAX_PARSED_CELLS || textLength >= MAX_EXTRACTED_CHARS) { partial = true; return; }
      rowsRead++;
      const current: Record<string, string | number | null> = {};
      const displayed: string[] = [];
      row.eachCell({ includeEmpty: false }, cell => {
        if (cellsRead >= MAX_PARSED_CELLS || textLength >= MAX_EXTRACTED_CHARS) { partial = true; return; }
        cellsRead++;
        const value = cellValue(cell.value);
        const rawCell = cell.value;
        if (row.number === 1) firstRow.push(String(value ?? cell.address));
        const key = String(cell.fullAddress.col - 1);
        current[key] = value;
        let shown = `${cell.address}=${String(value ?? '')}`;
        if (rawCell && typeof rawCell === 'object' && 'formula' in rawCell) {
          shown = `${cell.address}=formula(${String(rawCell.formula)}); cached=${String(rawCell.result ?? '[缺少缓存值]')}`;
        }
        displayed.push(shown);
      });
      if (displayed.length) {
        rowTexts.push(displayed.join(' | '));
        rowEnd = row.number;
        textLength += displayed.join(' | ').length;
        if (rowTexts.length === 1) rowStart = row.number;
        if (rowTexts.length >= 40 || textLength >= MAX_EXTRACTED_CHARS) {
          chunks.push({ locator: { kind: 'worksheet_range', sheet: sheet.name, range: `${rowStart}:${rowEnd}`, hidden }, text: rowTexts.splice(0).join('\n') });
          rowStart = row.number + 1;
        }
        values.push(current);
      }
    });
    if (rowTexts.length) chunks.push({ locator: { kind: 'worksheet_range', sheet: sheet.name, range: `${rowStart}:${rowEnd}`, hidden }, text: rowTexts.join('\n') });
    const columns = firstRow.map((label, index) => datasetColumn(String(index), label || `列 ${index + 1}`));
    if (values.length) datasets.push({ name: sheet.name, columns, rows: values, rowStart: 2, rowEnd: rowCountDeclared, hidden });
    sheetCoverage.push({ name: sheet.name, hidden, rowsDeclared: rowCountDeclared, columnsDeclared: colCountDeclared,
      rowsRead: values.length, mergedRanges: sheet.model.merges ?? [] });
    if (partial) break;
  }
  const uncachedFormulaCount = workbook.worksheets.reduce((count, sheet) => {
    let n = 0;
    sheet.eachRow({ includeEmpty: false }, row => row.eachCell({ includeEmpty: false }, cell => {
      if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value && (cell.value as any).result == null) n++;
    }));
    return count + n;
  }, 0);
  const status = partial ? 'partial' : 'parsed';
  return { status, format: 'xlsx', chunks, datasets, textLength,
    coverage: { sheets: sheetCoverage, rowsRead, cellsRead, uncachedFormulaCount, formulasExecuted: false,
      omittedReason: partial ? '行数、单元格数或文本字符数达到解析上限' : null,
      comments: 'ExcelJS 公式仅保留公式文本与文件内缓存结果；不执行公式、宏或外部链接。' } };
}

type DelimitedRecord = { cells: string[]; physicalLineStart: number; physicalLineEnd: number };

function countUnquoted(line: string, delimiter: string) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index++;
      else quoted = !quoted;
    } else if (!quoted && char === delimiter) count++;
  }
  return count;
}

function parseDelimitedRecords(source: string, delimiter: string, maxRecords: number) {
  const records: DelimitedRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let physicalLine = 1;
  let recordStart = 1;
  let truncated = false;
  const finishRecord = (physicalLineEnd: number) => {
    cells.push(cell);
    records.push({ cells, physicalLineStart: recordStart, physicalLineEnd });
    cells = [];
    cell = '';
    recordStart = physicalLineEnd + 1;
    if (records.length >= maxRecords) truncated = true;
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index++; }
      else if (quoted) quoted = false;
      else if (cell.length === 0) quoted = true;
      else cell += char;
    } else if (!quoted && char === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (char === '\n') {
      if (quoted) { cell += '\n'; physicalLine++; }
      else {
        finishRecord(physicalLine);
        physicalLine++;
        if (truncated) break;
      }
    } else cell += char;
  }
  const hasPendingRecord = cells.length > 0 || cell.length > 0 || (source.length > 0 && !source.endsWith('\n'));
  if (!truncated && hasPendingRecord) finishRecord(physicalLine);
  return { records, truncated, physicalLines: source ? (source.match(/\n/g) || []).length + (source.endsWith('\n') ? 0 : 1) : 0,
    linesRead: records.at(-1)?.physicalLineEnd || physicalLine };
}

function parseDelimited(fileName: string, buffer: Buffer): ParseResult {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const firstLine = source.split('\n').find(line => line.trim()) || '';
  const tabs = countUnquoted(firstLine, '\t');
  const commas = countUnquoted(firstLine, ',');
  const delimiter = tabs > commas ? '\t' : ',';
  const format = path.extname(fileName).toLowerCase().slice(1) || 'txt';
  const parsed = parseDelimitedRecords(source, delimiter, MAX_PARSED_ROWS + 1);
  const parsedRecords = parsed.records;
  let textLength = 0;
  const chunks: ParsedChunk[] = [];
  const headerRecord = parsedRecords[0];
  const header = headerRecord?.cells || [];
  const columns = header.map((label, index) => datasetColumn(String(index), label || `列 ${index + 1}`));
  const rows: Array<Record<string, string | number | null>> = [];
  const dataRecords = parsedRecords.slice(1);
  for (let start = 0; start < dataRecords.length && textLength < MAX_EXTRACTED_CHARS; start += 50) {
    const block = dataRecords.slice(start, Math.min(start + 50, dataRecords.length));
    const text = block.map((record, offset) => `row ${start + offset + 2}: ${record.cells.map((cell, index) => `${header[index] || `列 ${index + 1}`}=${cell}`).join(' | ')}`).join('\n');
    const bounded = text.slice(0, MAX_EXTRACTED_CHARS - textLength);
    if (bounded) chunks.push({ locator: { kind: 'delimited_rows', rowStart: start + 2, rowEnd: start + block.length + 1,
      physicalLineStart: block[0].physicalLineStart, physicalLineEnd: block[block.length - 1].physicalLineEnd,
      delimiter: delimiter === '\t' ? 'tab' : 'comma', encoding: 'UTF-8' }, text: bounded });
    textLength += bounded.length;
    for (const sourceRow of block) {
      const record: Record<string, string | number | null> = {};
      for (let col = 0; col < header.length; col++) record[String(col)] = sourceRow.cells[col] ?? null;
      rows.push(record);
    }
  }
  const partial = parsed.truncated || source.length > MAX_EXTRACTED_CHARS;
  return { status: partial ? 'partial' : 'parsed', format, chunks, textLength,
    datasets: rows.length ? [{ name: path.basename(fileName), columns, rows, rowStart: 2, rowEnd: rows.length + 1 }] : [],
    coverage: { encoding: 'UTF-8 (invalid byte replacement may occur)', delimiter: delimiter === '\t' ? 'tab' : 'comma',
      headerRow: 1, linesRead: parsed.linesRead, linesInFile: parsed.physicalLines, logicalRowsRead: parsedRecords.length, missingValues: '空字段保留为空值',
      omittedReason: partial ? '行数或文本字符数达到解析上限' : null } };
}

export async function parseResearchFile(fileName: string, buffer: Buffer): Promise<ParseResult> {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.docx') return parseDocx(buffer);
  if (ext === '.xlsx') return parseXlsx(buffer);
  if (['.csv', '.tsv', '.txt'].includes(ext)) return parseDelimited(fileName, buffer);
  return { status: 'unsupported', format: ext.slice(1) || 'unknown', chunks: [], datasets: [], textLength: 0,
    coverage: { parsed: false, reason: '当前环境未配置此格式的安全文本解析器；原文件仍保留并可下载。', conversionService: null } };
}

export function hashContent(value: Buffer | string) { return sha256(value); }
