export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx'

/** Select library guidance only; never infer page counts, content or acceptance
 * criteria from a format. Pass trusted task text, not fetched tool content.
 */
export function requestedDocumentFormats(task: string): DocumentFormat[] {
  const signals: Array<[DocumentFormat, RegExp]> = [
    ['pdf', /\bpdf\b/iu],
    ['docx', /\b(?:docx|word\s+document)\b|Word文档/iu],
    ['xlsx', /\b(?:xlsx|excel|workbook|spreadsheet)\b|电子表格|工作簿/iu],
    ['pptx', /\b(?:pptx|powerpoint)\b|PPT演示/iu],
  ]
  return signals.filter(([, pattern]) => pattern.test(task)).map(([format]) => format)
}

export const REGISTRY_INSTALL_POLICY = '- Use install_npm_packages for explicitly requested npm registry dependencies or a required artifact library. Respect pinned versions. Lifecycle scripts, audit, and funding calls are disabled. Bash has no package-network access: never replace this tool with npm, curl, pip, or another network path. After installation use Bash for local generators, builds and tests; successful requested checks establish installation without redundant import/version/environment probes. Every runtime filesystem path in source code must be workspace-relative; /home/user is a public tool-argument namespace, not a portable source-code path.'

const COMMON_DOCUMENT_POLICY = '- Structured artifact contract: use a library appropriate to the requested format and preserve the actual requested content, order, formulas, semantics and layout. This runtime does not preinstall openpyxl, python-docx, python-pptx, or expose pip package-network access. Keep source data and rendered content consistent; a specification assertion alone does not prove the content was rendered. Execute the generator, then use extract_attachment on the generated file as an independent parser. Consume its continuations and compare parsed structure and content with the request. OFFICE VERIFICATION FAILED, missing required content and semantic mismatches block presentation. Verification receipts bind parsed bytes, not overall quality: after changing the artifact re-verify affected requirements at the new revision. Preserve successful work, repair concrete defects, and read exact current source when it is not retained before editing. No arbitrary generator-count, helper-count or page-count limit substitutes for verified completion. Do not repeat unchanged checks without an unresolved requirement.'

const FORMAT_POLICY: Record<DocumentFormat, string> = {
  pdf: '- PDF API guidance: use a real PDF writer. When selectable text or vector content is required, render those directly rather than renaming HTML or embedding a whole-page screenshot. With pdf-lib, embed fonts through PDFDocument and pass them to page renderers; PDFPage has no public page.doc.getFont API. Derive text and panel bounds from the actual page dimensions, requested margins, font metrics and baseline semantics. Verify required visible content on its assigned page, not merely its presence in metadata or a source specification. Do not impose a fixed paper size, margin, decorative shape or renderer structure absent from the request.',
  docx: '- DOCX API guidance: use actual paragraph styles, numbering, page breaks and fields when those semantics are requested. In docx, Title uses HeadingLevel.TITLE and dynamic page numbering uses PageNumber.CURRENT; a bold paragraph or typed PAGE string does not implement those features. Construct Header/Footer and formatting through public constructors, not internal .options mutation. Verify the parsed document structure, table dimensions, row-to-cell mapping, headings and fields against the request. Do not impose a particular section count or add unrequested table headers. The docx writer is not a reliable reopen/parser API; use independent extraction.',
  xlsx: '- XLSX API guidance: with ExcelJS, formula expressions omit the destination cell and leading equals sign. Derive references from actual source coordinates. Preserve explicitly requested direct links and aggregation ranges rather than substituting cached values or equivalent-looking formulas. Use cell.formula for the expression and cell.result for its cached value; cell.value can be a formula object. Use public worksheet/cell APIs, not a nonexistent worksheet.getRange or assignment to wb.worksheets. Reopen the generated workbook and inspect requested sheet order, labels, formulas, cached values and number formats; compare the independent extraction too. Do not hardcode summary coordinates, source labels or business totals from examples.',
  pptx: '- PPTX API guidance: PptxGenJS addTable accepts an array of row arrays; project object records through explicit ordered columns before rendering. addChart accepts an array of series objects with aligned labels and values, not a raw value array. Pie/doughnut categories belong in one series. Validate actual rendered data shape, requested slide order, content and notes through independent extraction. PptxGenJS is a writer, not a reliable reopen/parser API. Do not substitute a fixed category set, series values or slide count for the request.',
}

export function documentAuthoringPolicy(formats: readonly DocumentFormat[]): string[] {
  const selected = [...new Set(formats)].filter((format) => Object.hasOwn(FORMAT_POLICY, format))
  return selected.length ? [COMMON_DOCUMENT_POLICY, ...selected.map((format) => FORMAT_POLICY[format])] : []
}
