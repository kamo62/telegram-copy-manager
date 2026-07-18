const cssPath = "apps/web/src/styles/base.css";
const source = await Bun.file(cssPath).text();

export {};

const withoutComments = (value: string) => value.replace(/\/\*[\s\S]*?\*\//g, "");
const normalized = (value: string) => withoutComments(value).replace(/\s+/g, " ").trim();
const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;

const firstRuleByContent = new Map<string, number>();
const duplicates: Array<{ selector: string; firstLine: number; duplicateLine: number }> = [];
let statementStart = 0;
let quote: '"' | "'" | undefined;
let escaped = false;
let inComment = false;

for (let index = 0; index < source.length; index += 1) {
  const character = source[index];
  const next = source[index + 1];

  if (inComment) {
    if (character === "*" && next === "/") {
      inComment = false;
      index += 1;
    }
    continue;
  }
  if (quote) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === quote) quote = undefined;
    continue;
  }
  if (character === "/" && next === "*") {
    inComment = true;
    index += 1;
    continue;
  }
  if (character === '"' || character === "'") {
    quote = character;
    continue;
  }
  if (character === ";") {
    statementStart = index + 1;
    continue;
  }
  if (character !== "{") continue;

  const selectorStart = statementStart;
  const selector = normalized(source.slice(selectorStart, index));
  let depth = 1;
  const bodyStart = index + 1;
  let bodyQuote: '"' | "'" | undefined;
  let bodyEscaped = false;
  let bodyComment = false;
  for (index += 1; index < source.length && depth > 0; index += 1) {
    const bodyCharacter = source[index];
    const bodyNext = source[index + 1];
    if (bodyComment) {
      if (bodyCharacter === "*" && bodyNext === "/") {
        bodyComment = false;
        index += 1;
      }
      continue;
    }
    if (bodyQuote) {
      if (bodyEscaped) bodyEscaped = false;
      else if (bodyCharacter === "\\") bodyEscaped = true;
      else if (bodyCharacter === bodyQuote) bodyQuote = undefined;
      continue;
    }
    if (bodyCharacter === "/" && bodyNext === "*") {
      bodyComment = true;
      index += 1;
      continue;
    }
    if (bodyCharacter === '"' || bodyCharacter === "'") {
      bodyQuote = bodyCharacter;
      continue;
    }
    if (bodyCharacter === "{") depth += 1;
    else if (bodyCharacter === "}") depth -= 1;
  }

  const closingBrace = index - 1;
  if (selector && !selector.startsWith("@")) {
    const key = `${selector}\u0000${normalized(source.slice(bodyStart, closingBrace))}`;
    const firstLine = firstRuleByContent.get(key);
    if (firstLine !== undefined) {
      duplicates.push({ selector, firstLine, duplicateLine: lineAt(selectorStart) });
    } else {
      firstRuleByContent.set(key, lineAt(selectorStart));
    }
  }
  statementStart = index;
  index -= 1;
}

if (duplicates.length > 0) {
  console.error(`Exact duplicate top-level CSS rules found in ${cssPath}:`);
  for (const duplicate of duplicates) {
    console.error(
      `  ${duplicate.selector} at line ${duplicate.duplicateLine} duplicates line ${duplicate.firstLine}`,
    );
  }
  process.exit(1);
}

console.log(`No exact duplicate top-level CSS rules in ${cssPath}.`);
