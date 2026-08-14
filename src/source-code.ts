import * as ts from "typescript";

import {
  ProjectionCore,
  validationFailure,
  validationSuccess,
  type Adapter,
  type ComponentIdentity,
  type ProjectionCoreOptions,
  type ProjectionSource,
  type SemanticContract,
  type ValidationResult,
  type View,
} from "./core.js";

export const TYPESCRIPT_SOURCE_SEMANTIC_TYPE = "typescript-source";
export const TYPESCRIPT_SOURCE_MODEL_VERSION = "1.0.0";
export const TYPESCRIPT_SOURCE_ADAPTER_ID = "typescript-source";
export const TYPESCRIPT_SOURCE_ADAPTER_VERSION = "1.0.0";
export const TYPESCRIPT_SOURCE_CONTRACT_ID = "typescript-source-contract";
export const TYPESCRIPT_SOURCE_CONTRACT_VERSION = "1.0.0";
export const TYPESCRIPT_SYMBOL_INDEX_VIEW_ID = "typescript-symbol-index";
export const TYPESCRIPT_SYMBOL_INDEX_VIEW_VERSION = "1.0.0";
export const TYPESCRIPT_SYMBOL_DETAIL_VIEW_ID = "typescript-symbol-detail";
export const TYPESCRIPT_SYMBOL_DETAIL_VIEW_VERSION = "1.0.0";

export const GENERIC_TEXT_SEMANTIC_TYPE = "generic-text";
export const GENERIC_TEXT_MODEL_VERSION = "1.0.0";
export const GENERIC_TEXT_ADAPTER_ID = "generic-text";
export const GENERIC_TEXT_ADAPTER_VERSION = "1.0.0";
export const GENERIC_TEXT_CONTRACT_ID = "generic-text-contract";
export const GENERIC_TEXT_CONTRACT_VERSION = "1.0.0";
export const GENERIC_TEXT_VIEW_ID = "generic-text-view";
export const GENERIC_TEXT_VIEW_VERSION = "1.0.0";

export type TypeScriptSourceLanguage = "typescript" | "tsx";

export type TypeScriptSymbolKind =
  | "class"
  | "constant"
  | "constructor"
  | "enum"
  | "enum-member"
  | "function"
  | "get-accessor"
  | "interface"
  | "method"
  | "module"
  | "parameter"
  | "property"
  | "set-accessor"
  | "type"
  | "variable"
  | "unknown";

export interface TypeScriptSourcePosition {
  /** UTF-16 source offset, zero based. */
  readonly offset: number;
  /** Zero-based line number. */
  readonly line: number;
  /** Zero-based UTF-16 character within the line. */
  readonly character: number;
}

export interface TypeScriptSourceRange {
  /** Inclusive start and exclusive end UTF-16 offsets. */
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface TypeScriptSourceSymbol {
  /** Stable within a decoded source model. */
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: TypeScriptSymbolKind;
  readonly exported: boolean;
  readonly range: TypeScriptSourceRange;
  readonly parentId?: string;
  /** Canonical source-level signature when the declaration exposes one. */
  readonly signature?: string;
  /** Explicitly declared type or return type, when present. */
  readonly type?: string;
}

export interface TypeScriptSourceSemanticModel {
  readonly model: typeof TYPESCRIPT_SOURCE_SEMANTIC_TYPE;
  readonly version: typeof TYPESCRIPT_SOURCE_MODEL_VERSION;
  readonly fileName: string;
  readonly language: TypeScriptSourceLanguage;
  readonly symbols: readonly TypeScriptSourceSymbol[];
}

/** Shorter public alias for consumers that call the model a source model. */
export type TypeScriptSourceModel = TypeScriptSourceSemanticModel;

export interface TypeScriptSymbolIndexProjection extends TypeScriptSourceSemanticModel {}

export interface TypeScriptSymbolDetailProjection {
  readonly model: typeof TYPESCRIPT_SOURCE_SEMANTIC_TYPE;
  readonly version: typeof TYPESCRIPT_SOURCE_MODEL_VERSION;
  readonly fileName: string;
  readonly language: TypeScriptSourceLanguage;
  readonly symbol: TypeScriptSourceSymbol;
}

export interface GenericTextSemanticModel {
  readonly model: typeof GENERIC_TEXT_SEMANTIC_TYPE;
  readonly version: typeof GENERIC_TEXT_MODEL_VERSION;
  readonly text: string;
}

export type GenericTextModel = GenericTextSemanticModel;

export interface TypeScriptSymbolSelector {
  readonly id?: string;
  readonly name?: string;
  readonly qualifiedName?: string;
  readonly kind?: TypeScriptSymbolKind;
  readonly index?: number;
}

export type SymbolSelection = string | TypeScriptSymbolSelector;

export interface SourceSemanticContractMetadata {
  /** Human- and machine-readable statement of what the contract preserves. */
  readonly semanticGuarantees: readonly string[];
  /** Explicit loss statement; this is metadata, not an automatic fallback policy. */
  readonly lossContract: {
    readonly strength: "strong" | "weak";
    readonly description: string;
  };
}

export interface SourceSemanticContract<TSemantic = unknown>
  extends SemanticContract<TSemantic>, SourceSemanticContractMetadata {}

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const signaturePrinter = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

interface ParsedTypeScriptSource {
  readonly fileName: string;
  readonly language: TypeScriptSourceLanguage;
  readonly text: string;
  readonly sourceFile: ts.SourceFile;
  readonly diagnostics: readonly ts.Diagnostic[];
}

interface ParseFailure {
  readonly issue: {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

type ParseResult = { readonly parsed: ParsedTypeScriptSource } | ParseFailure;

interface RawSymbol {
  readonly node: ts.Node;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: TypeScriptSymbolKind;
  readonly type?: string;
  readonly signature?: string;
  readonly exported: boolean;
  readonly parentIndex?: number;
  readonly range: TypeScriptSourceRange;
}

export const typescriptSourceAdapter: Adapter<TypeScriptSourceSemanticModel> & SourceSemanticContractMetadata = {
  id: TYPESCRIPT_SOURCE_ADAPTER_ID,
  version: TYPESCRIPT_SOURCE_ADAPTER_VERSION,
  semanticType: TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
  contract: TYPESCRIPT_SOURCE_CONTRACT_ID,
  semanticGuarantees: [
    "declaration identity",
    "symbol kind and name",
    "source range",
    "explicit signature and type text",
    "lightweight declaration containment",
  ],
  lossContract: {
    strength: "strong",
    description:
      "Preserves deterministic declaration evidence; comments, formatting, bodies, and inferred program-wide facts are outside the model.",
  },
  validate: validateTypeScriptSource,
  decode: decodeTypeScriptSource,
};

export const typescriptSourceCodeAdapter = typescriptSourceAdapter;
export const typescriptAdapter = typescriptSourceAdapter;

export const typescriptSourceContract: SourceSemanticContract<TypeScriptSourceSemanticModel> = {
  id: TYPESCRIPT_SOURCE_CONTRACT_ID,
  version: TYPESCRIPT_SOURCE_CONTRACT_VERSION,
  semanticType: TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
  semanticGuarantees: typescriptSourceAdapter.semanticGuarantees,
  lossContract: typescriptSourceAdapter.lossContract,
  validate: validateTypeScriptModel,
};

export const typescriptSourceSemanticContract = typescriptSourceContract;

export const typescriptSymbolIndexView: View<TypeScriptSymbolIndexProjection> = {
  id: TYPESCRIPT_SYMBOL_INDEX_VIEW_ID,
  version: TYPESCRIPT_SYMBOL_INDEX_VIEW_VERSION,
  semanticType: TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
  meaning: {
    required: ["model", "version", "fileName", "language"],
    preserved: ["symbols"],
    discarded: [],
    priorities: [{ path: "symbols", priority: 1 }],
  },
  project: ({ semantic }) => {
    assertTypeScriptModel(semantic);
    return semantic;
  },
};

export const typescriptSourceSymbolIndexView = typescriptSymbolIndexView;

export function createTypeScriptSymbolDetailView(selection: SymbolSelection): View<TypeScriptSymbolDetailProjection> {
  const selector = normalizeSelector(selection);
  const selectorKey = selectorIdentity(selector);
  return {
    id: `${TYPESCRIPT_SYMBOL_DETAIL_VIEW_ID}:${encodeURIComponent(selectorKey)}`,
    version: TYPESCRIPT_SYMBOL_DETAIL_VIEW_VERSION,
    semanticType: TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
    meaning: {
      required: ["model", "version", "fileName", "language", "symbol"],
      preserved: ["symbol"],
      discarded: [],
    },
    project: ({ semantic }) => {
      assertTypeScriptModel(semantic);
      const symbol = selectSymbol(semantic, selector);
      return {
        model: semantic.model,
        version: semantic.version,
        fileName: semantic.fileName,
        language: semantic.language,
        symbol,
      };
    },
  };
}

export const createTypeScriptSelectedSymbolView = createTypeScriptSymbolDetailView;
export const createTypeScriptSymbolSignatureView = createTypeScriptSymbolDetailView;
export const createTypeScriptSymbolView = createTypeScriptSymbolDetailView;
export const createTypeScriptSourceSymbolView = createTypeScriptSymbolDetailView;

export const genericTextAdapter: Adapter<GenericTextSemanticModel> & SourceSemanticContractMetadata = {
  id: GENERIC_TEXT_ADAPTER_ID,
  version: GENERIC_TEXT_ADAPTER_VERSION,
  semanticType: GENERIC_TEXT_SEMANTIC_TYPE,
  contract: GENERIC_TEXT_CONTRACT_ID,
  semanticGuarantees: ["normalized UTF-8 text only"],
  lossContract: {
    strength: "weak",
    description:
      "Preserves text representation after line-ending/BOM normalization; it does not preserve declarations, symbol identity, types, or containment.",
  },
  validate: validateGenericTextSource,
  decode: decodeGenericText,
};

export const genericTextFallbackAdapter = genericTextAdapter;
export const genericTextSourceAdapter = genericTextAdapter;

export const genericTextContract: SourceSemanticContract<GenericTextSemanticModel> = {
  id: GENERIC_TEXT_CONTRACT_ID,
  version: GENERIC_TEXT_CONTRACT_VERSION,
  semanticType: GENERIC_TEXT_SEMANTIC_TYPE,
  semanticGuarantees: genericTextAdapter.semanticGuarantees,
  lossContract: genericTextAdapter.lossContract,
  validate: validateGenericTextModel,
};

export const genericTextSemanticContract = genericTextContract;

export const genericTextView: View<GenericTextSemanticModel> = {
  id: GENERIC_TEXT_VIEW_ID,
  version: GENERIC_TEXT_VIEW_VERSION,
  semanticType: GENERIC_TEXT_SEMANTIC_TYPE,
  meaning: {
    required: ["model", "version", "text"],
    preserved: ["text"],
    discarded: [],
  },
  project: ({ semantic }) => {
    assertGenericTextModel(semantic);
    return semantic;
  },
};

export const genericTextFallbackView = genericTextView;

export const sourceSemanticAdapters = Object.freeze([genericTextAdapter, typescriptSourceAdapter]);
export const sourceSemanticContracts = Object.freeze([genericTextContract, typescriptSourceContract]);
export const sourceSemanticViews = Object.freeze([genericTextView, typescriptSymbolIndexView]);

/** Register only the explicit source components; no adapter is auto-selected. */
export function registerSourceSemanticComponents(core: ProjectionCore): ProjectionCore {
  core.adapters.registerMany(sourceSemanticAdapters);
  core.semanticContracts.registerMany(sourceSemanticContracts);
  core.views.registerMany(sourceSemanticViews);
  return core;
}

/** Convenience factory for a core with the two source adapters and their fixed views. */
export function createSourceProjectionCore(options: ProjectionCoreOptions = {}): ProjectionCore {
  return registerSourceSemanticComponents(new ProjectionCore(options));
}

export const createSourceCodeProjectionCore = createSourceProjectionCore;
export const createTypeScriptSourceCore = createSourceProjectionCore;

export function validateTypeScriptSource(source: ProjectionSource): ValidationResult {
  const result = parseTypeScriptSource(source);
  if ("issue" in result) {
    return validationFailure(result.issue);
  }
  if (result.parsed.diagnostics.length > 0) {
    return validationFailure(result.parsed.diagnostics.map((diagnostic) => diagnosticIssue(result.parsed, diagnostic)));
  }
  return validationSuccess();
}

export function decodeTypeScriptSource(source: ProjectionSource): TypeScriptSourceSemanticModel {
  const result = parseTypeScriptSource(source);
  if ("issue" in result) {
    throw new TypeScriptSourceSyntaxError(result.issue.message, result.issue);
  }
  if (result.parsed.diagnostics.length > 0) {
    const issues = result.parsed.diagnostics.map((diagnostic) => diagnosticIssue(result.parsed, diagnostic));
    throw new TypeScriptSourceSyntaxError(issues.map((issue) => issue.message).join("\n"), issues[0]);
  }
  return collectTypeScriptSymbols(result.parsed);
}

export class TypeScriptSourceSyntaxError extends Error {
  readonly issue: Readonly<Record<string, unknown>>;

  constructor(message: string, issue: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "TypeScriptSourceSyntaxError";
    this.issue = issue;
  }
}

function parseTypeScriptSource(source: ProjectionSource): ParseResult {
  let text: string;
  try {
    text = typeof source.content === "string" ? source.content : textDecoder.decode(source.content);
  } catch (error) {
    return {
      issue: {
        code: "SOURCE_ENCODING_ERROR",
        message: error instanceof Error ? error.message : "The source is not valid UTF-8.",
        details: { mediaType: source.mediaType ?? "unknown" },
      },
    };
  }

  const fileName = sourceFileName(source);
  const scriptKind = scriptKindForFileName(fileName, source.mediaType);
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = sourceDiagnostics(sourceFile);
  return {
    parsed: {
      fileName,
      language: scriptKind === ts.ScriptKind.TSX ? "tsx" : "typescript",
      text,
      sourceFile,
      diagnostics,
    },
  };
}

function sourceFileName(source: ProjectionSource): string {
  const identity = source.identity?.trim();
  if (identity !== undefined && identity !== "") {
    return identity;
  }
  const mediaType = source.mediaType?.toLowerCase() ?? "";
  if (mediaType.includes("tsx") || mediaType.includes("react")) {
    return "source.tsx";
  }
  return "source.ts";
}

function scriptKindForFileName(fileName: string, mediaType: string | undefined): ts.ScriptKind {
  const normalized = fileName.toLowerCase();
  const normalizedMediaType = mediaType?.toLowerCase() ?? "";
  if (normalized.endsWith(".tsx") || normalizedMediaType.includes("tsx") || normalizedMediaType.includes("react")) {
    return ts.ScriptKind.TSX;
  }
  if (normalized.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (normalized.endsWith(".js") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function sourceDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  const withDiagnostics = sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] };
  return withDiagnostics.parseDiagnostics ?? [];
}

function diagnosticIssue(
  parsed: ParsedTypeScriptSource,
  diagnostic: ts.Diagnostic,
): {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  const start = diagnostic.start ?? 0;
  const length = diagnostic.length ?? 0;
  const boundedStart = Math.max(0, Math.min(start, parsed.text.length));
  const position = parsed.sourceFile.getLineAndCharacterOfPosition(boundedStart);
  return {
    code: "TYPESCRIPT_PARSE_ERROR",
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    path: `${parsed.fileName}:${position.line + 1}:${position.character + 1}`,
    details: {
      start: boundedStart,
      length,
      category: diagnostic.category,
      diagnosticCode: diagnostic.code,
    },
  };
}

function collectTypeScriptSymbols(parsed: ParsedTypeScriptSource): TypeScriptSourceSemanticModel {
  const exportedNames = exportedLocalNames(parsed.sourceFile);
  const rawSymbols: RawSymbol[] = [];

  const visit = (node: ts.Node, parentIndex: number | undefined): void => {
    const info = symbolInfo(node, parsed.sourceFile, parsed.text);
    let nextParent = parentIndex;
    if (info !== undefined) {
      const index = rawSymbols.length;
      const qualifiedName =
        parentIndex === undefined ? info.name : `${rawSymbols[parentIndex].qualifiedName}.${info.name}`;
      const raw: RawSymbol = {
        ...info,
        qualifiedName,
        exported: info.exported || (parentIndex === undefined && exportedNames.has(info.name)),
        parentIndex,
      };
      rawSymbols.push(raw);
      nextParent = index;
    }
    ts.forEachChild(node, (child) => visit(child, nextParent));
  };

  visit(parsed.sourceFile, undefined);

  const symbols = rawSymbols
    .map((raw) => ({ raw, rangeStart: raw.range.start, rangeEnd: raw.range.end }))
    .sort(
      (left, right) =>
        left.rangeStart - right.rangeStart ||
        left.rangeEnd - right.rangeEnd ||
        left.raw.name.localeCompare(right.raw.name),
    )
    .map((entry) => entry.raw);
  const ids = new Map<RawSymbol, string>();
  for (const raw of symbols) {
    ids.set(raw, `${raw.kind}:${raw.qualifiedName}:${raw.range.start}`);
  }

  return Object.freeze({
    model: TYPESCRIPT_SOURCE_SEMANTIC_TYPE,
    version: TYPESCRIPT_SOURCE_MODEL_VERSION,
    fileName: parsed.fileName,
    language: parsed.language,
    symbols: Object.freeze(
      symbols.map((raw) =>
        Object.freeze({
          id: ids.get(raw) as string,
          name: raw.name,
          qualifiedName: raw.qualifiedName,
          kind: raw.kind,
          exported: raw.exported,
          range: raw.range,
          ...(raw.parentIndex === undefined ? {} : { parentId: ids.get(rawSymbols[raw.parentIndex]) }),
          ...(raw.signature === undefined ? {} : { signature: raw.signature }),
          ...(raw.type === undefined ? {} : { type: raw.type }),
        }),
      ),
    ),
  });
}

function symbolInfo(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  sourceText: string,
): Omit<RawSymbol, "qualifiedName" | "parentIndex"> | undefined {
  const kind = symbolKind(node);
  if (kind === undefined) {
    return undefined;
  }
  const name = declarationName(node, sourceFile);
  if (name === undefined) {
    return undefined;
  }
  const range = sourceRange(node, sourceFile);
  const type = declaredType(node, sourceFile);
  return {
    node,
    name,
    kind,
    type,
    signature: declarationSignature(node, kind, name, sourceFile, sourceText),
    exported: directlyExported(node),
    range,
  };
}

function symbolKind(node: ts.Node): TypeScriptSymbolKind | undefined {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isModuleDeclaration(node)) return "module";
  if (ts.isVariableDeclaration(node)) {
    const declarationList = node.parent;
    if (ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0) {
      return "constant";
    }
    return "variable";
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isGetAccessorDeclaration(node)) return "get-accessor";
  if (ts.isSetAccessorDeclaration(node)) return "set-accessor";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isEnumMember(node)) return "enum-member";
  return undefined;
}

function declarationName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name === undefined ? "default" : node.name.getText(sourceFile);
  }
  if (
    ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isParameter(node) ||
    ts.isEnumMember(node)
  ) {
    return node.name.getText(sourceFile);
  }
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name.getText(sourceFile);
  }
  return undefined;
}

function directlyExported(node: ts.Node): boolean {
  if (hasExportModifier(node)) {
    return true;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.isVariableStatement(node.parent.parent)
  ) {
    return hasExportModifier(node.parent.parent);
  }
  return false;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (node as ts.Node & { readonly modifiers?: ts.NodeArray<ts.Modifier> }).modifiers;
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) ?? false
  );
}

function exportedLocalNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isExportDeclaration(node) || node.exportClause === undefined || !ts.isNamedExports(node.exportClause)) {
      return;
    }
    for (const element of node.exportClause.elements) {
      names.add(element.propertyName?.text ?? element.name.text);
    }
  });
  return names;
}

function sourceRange(node: ts.Node, sourceFile: ts.SourceFile): TypeScriptSourceRange {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const startPosition = sourceFile.getLineAndCharacterOfPosition(start);
  const endPosition = sourceFile.getLineAndCharacterOfPosition(end);
  return Object.freeze({
    start,
    end,
    startLine: startPosition.line,
    startCharacter: startPosition.character,
    endLine: endPosition.line,
    endCharacter: endPosition.character,
  });
}

function declaredType(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isParameter(node)
  ) {
    return printType(node.type, sourceFile);
  }
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return printType(node.type, sourceFile);
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return printType(node.type, sourceFile);
  }
  return undefined;
}

function printType(node: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const printed = signaturePrinter.printNode(ts.EmitHint.Unspecified, node, sourceFile).trim();
  return printed === "" ? undefined : printed;
}

function declarationSignature(
  node: ts.Node,
  kind: TypeScriptSymbolKind,
  name: string,
  sourceFile: ts.SourceFile,
  sourceText: string,
): string | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const parameters = node.parameters.map((parameter) => parameterSignature(parameter, sourceFile)).join(", ");
    const returnType = printType(node.type, sourceFile);
    return `${name}(${parameters})${returnType === undefined ? "" : `: ${returnType}`}`;
  }
  if (ts.isConstructorDeclaration(node)) {
    return `constructor(${node.parameters.map((parameter) => parameterSignature(parameter, sourceFile)).join(", ")})`;
  }
  if (ts.isVariableDeclaration(node)) {
    const declarationKind = variableDeclarationKeyword(node);
    const type = printType(node.type, sourceFile);
    return `${declarationKind} ${name}${type === undefined ? "" : `: ${type}`}`;
  }
  if (ts.isClassDeclaration(node)) return `class ${name}`;
  if (ts.isInterfaceDeclaration(node)) return `interface ${name}`;
  if (ts.isTypeAliasDeclaration(node)) {
    const type = printType(node.type, sourceFile);
    return `type ${name}${type === undefined ? "" : ` = ${type}`}`;
  }
  if (ts.isEnumDeclaration(node)) return `enum ${name}`;
  if (ts.isModuleDeclaration(node)) return `namespace ${name}`;
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) {
    const type = printType(node.type, sourceFile);
    return `${name}${"questionToken" in node && node.questionToken !== undefined ? "?" : ""}${type === undefined ? "" : `: ${type}`}`;
  }
  if (ts.isEnumMember(node)) return `enum-member ${name}`;
  if (kind === "unknown") return sourceText.slice(node.getStart(sourceFile), node.getEnd()).trim();
  return undefined;
}

function variableDeclarationKeyword(node: ts.VariableDeclaration): "const" | "let" | "var" {
  const declarationList = node.parent;
  if (!ts.isVariableDeclarationList(declarationList)) {
    return "let";
  }
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }
  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) {
    return "let";
  }
  return "var";
}

function parameterSignature(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): string {
  const name = parameter.name.getText(sourceFile);
  const rest = parameter.dotDotDotToken === undefined ? "" : "...";
  const optional = parameter.questionToken === undefined ? "" : "?";
  const type = printType(parameter.type, sourceFile);
  return `${rest}${name}${optional}${type === undefined ? "" : `: ${type}`}`;
}

function validateTypeScriptModel(value: unknown): ValidationResult {
  if (!isTypeScriptModel(value)) {
    return validationFailure({
      code: "INVALID_TYPESCRIPT_MODEL",
      message: "expected a versioned TypeScript source semantic model",
    });
  }
  for (const symbol of value.symbols) {
    if (
      symbol.id.trim() === "" ||
      symbol.name.trim() === "" ||
      symbol.range.start < 0 ||
      symbol.range.end < symbol.range.start
    ) {
      return validationFailure({
        code: "INVALID_TYPESCRIPT_SYMBOL",
        message: "symbol identity and source range must be valid",
        path: `symbols.${symbol.id}`,
      });
    }
  }
  return validationSuccess();
}

function validateGenericTextSource(source: ProjectionSource): ValidationResult {
  try {
    if (typeof source.content === "string") {
      return validationSuccess();
    }
    textDecoder.decode(source.content);
    return validationSuccess();
  } catch (error) {
    return validationFailure({
      code: "SOURCE_ENCODING_ERROR",
      message: error instanceof Error ? error.message : "The source is not valid UTF-8.",
    });
  }
}

function decodeGenericText(source: ProjectionSource): GenericTextSemanticModel {
  const text = typeof source.content === "string" ? source.content : textDecoder.decode(source.content);
  return Object.freeze({
    model: GENERIC_TEXT_SEMANTIC_TYPE,
    version: GENERIC_TEXT_MODEL_VERSION,
    text: normalizeGenericText(text),
  });
}

function normalizeGenericText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function validateGenericTextModel(value: unknown): ValidationResult {
  if (!isGenericTextModel(value)) {
    return validationFailure({
      code: "INVALID_GENERIC_TEXT_MODEL",
      message: "expected a versioned generic-text semantic model",
    });
  }
  return validationSuccess();
}

function assertTypeScriptModel(value: unknown): asserts value is TypeScriptSourceSemanticModel {
  if (!isTypeScriptModel(value)) {
    throw new TypeError("The selected view requires a TypeScript source semantic model.");
  }
}

function assertGenericTextModel(value: unknown): asserts value is GenericTextSemanticModel {
  if (!isGenericTextModel(value)) {
    throw new TypeError("The selected view requires a generic-text semantic model.");
  }
}

function isTypeScriptModel(value: unknown): value is TypeScriptSourceSemanticModel {
  if (
    !isRecord(value) ||
    value.model !== TYPESCRIPT_SOURCE_SEMANTIC_TYPE ||
    value.version !== TYPESCRIPT_SOURCE_MODEL_VERSION
  ) {
    return false;
  }
  return (
    typeof value.fileName === "string" &&
    (value.language === "typescript" || value.language === "tsx") &&
    Array.isArray(value.symbols) &&
    value.symbols.every(isTypeScriptSymbol)
  );
}

function isTypeScriptSymbol(value: unknown): value is TypeScriptSourceSymbol {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.qualifiedName !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.exported !== "boolean"
  ) {
    return false;
  }
  if (!isRecord(value.range) || typeof value.range.start !== "number" || typeof value.range.end !== "number") {
    return false;
  }
  return value.range.start >= 0 && value.range.end >= value.range.start;
}

function isGenericTextModel(value: unknown): value is GenericTextSemanticModel {
  return (
    isRecord(value) &&
    value.model === GENERIC_TEXT_SEMANTIC_TYPE &&
    value.version === GENERIC_TEXT_MODEL_VERSION &&
    typeof value.text === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeSelector(selection: SymbolSelection): TypeScriptSymbolSelector {
  if (typeof selection === "string") {
    const value = selection.trim();
    if (value === "") {
      throw new TypeError("A selected TypeScript symbol must not be empty.");
    }
    return { id: value, name: value };
  }
  const selector = { ...selection };
  if (selector.index !== undefined && (!Number.isInteger(selector.index) || selector.index < 0)) {
    throw new TypeError("A symbol selector index must be a non-negative integer.");
  }
  if (
    selector.id === undefined &&
    selector.name === undefined &&
    selector.qualifiedName === undefined &&
    selector.index === undefined
  ) {
    throw new TypeError("A symbol selector must identify an id, name, qualified name, or index.");
  }
  return selector;
}

function selectorIdentity(selector: TypeScriptSymbolSelector): string {
  return [
    selector.id === undefined ? "" : `id=${selector.id}`,
    selector.name === undefined ? "" : `name=${selector.name}`,
    selector.qualifiedName === undefined ? "" : `qualified=${selector.qualifiedName}`,
    selector.kind === undefined ? "" : `kind=${selector.kind}`,
    selector.index === undefined ? "" : `index=${selector.index}`,
  ]
    .filter(Boolean)
    .join("&");
}

function selectSymbol(
  model: TypeScriptSourceSemanticModel,
  selector: TypeScriptSymbolSelector,
): TypeScriptSourceSymbol {
  if (selector.index !== undefined) {
    const symbol = model.symbols[selector.index];
    if (symbol !== undefined && matchesSelector(symbol, selector)) {
      return symbol;
    }
    throw new TypeError(
      `The selected TypeScript symbol index ${selector.index} does not match the requested selector.`,
    );
  }
  const matches = model.symbols.filter((symbol) => matchesSelector(symbol, selector));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    throw new TypeError(`No TypeScript symbol matches ${selectorIdentity(selector)}.`);
  }
  throw new TypeError(
    `The selector ${selectorIdentity(selector)} matches ${matches.length} TypeScript symbols; use an id or index.`,
  );
}

function matchesSelector(symbol: TypeScriptSourceSymbol, selector: TypeScriptSymbolSelector): boolean {
  return (
    (selector.id === undefined || symbol.id === selector.id) &&
    (selector.name === undefined || symbol.name === selector.name) &&
    (selector.qualifiedName === undefined || symbol.qualifiedName === selector.qualifiedName) &&
    (selector.kind === undefined || symbol.kind === selector.kind)
  );
}
