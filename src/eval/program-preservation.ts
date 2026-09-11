import ts from 'typescript'

/** Additive tests may change bytes without removing the original program.
 * Require original top-level statements as an ordered token-equivalent
 * subsequence. This does not replace executing both public and held-out tests.
 */
export function preservesProgramStatements(before: string, after: string): boolean {
  const statements = (source: string) => {
    const file = ts.createSourceFile('tests.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    return file.statements.map((statement) => {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, statement.getText(file))
      const tokens: Array<[number, string]> = []
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        tokens.push([token, token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NumericLiteral
          ? scanner.getTokenValue() : scanner.getTokenText()])
      }
      return JSON.stringify(tokens)
    })
  }
  const original = statements(before)
  if (!original.length) return false
  let next = 0
  for (const statement of statements(after)) if (statement === original[next]) next += 1
  return next === original.length
}
