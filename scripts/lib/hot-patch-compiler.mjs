import { createHash } from "node:crypto";
import ts from "typescript";
import path from "node:path";

const digest = value => createHash("sha256").update(value).digest("hex");

export function compileHotPatchModule(source, fileName = "module.ts") {
  fileName = path.resolve(fileName);
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], skipLibCheck: true, noEmit: true };
  const parsed = ts.createSourceFile(fileName, source, options.target, true, ts.ScriptKind.TS);
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...arguments_) => path.resolve(name) === fileName ? parsed : getSourceFile(name, ...arguments_);
  const program = ts.createProgram([fileName], options, host);
  const syntax = program.getSyntacticDiagnostics();
  if (syntax.length) throw new Error(ts.flattenDiagnosticMessageText(syntax[0].messageText, "\n"));
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const symbols = new Map();
  const names = [];
  const functions = [];
  const functionNames = [];
  const classes = new Map();
  const exported = [];
  const dependencies = [];
  const skeleton = [];
  const addBinding = name => {
    if (!ts.isIdentifier(name)) throw new Error("Hot patch module bindings must have explicit names.");
    if (name.text.startsWith("__rabiPatch") || name.text === "__proto__") throw new Error("Reserved hot patch binding name.");
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) symbols.set(symbol, name.text);
    names.push(name.text);
  };
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) {
        skeleton.push(printer.printNode(ts.EmitHint.Unspecified, statement, parsed));
        continue;
      }
      throw new Error("Hot patch modules use declared dependency bindings instead of runtime imports.");
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      skeleton.push(printer.printNode(ts.EmitHint.Unspecified, statement, parsed));
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      addBinding(statement.name);
      functions.push({ declaration: statement, id: statement.name.text });
      functionNames.push(statement.name.text);
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        throw new Error("Default exports require an explicit named module boundary.");
      }
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.push(statement.name.text);
      const signature = printer.printNode(ts.EmitHint.Unspecified,
        ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken, statement.name,
          statement.typeParameters, statement.parameters, statement.type, ts.factory.createBlock([])), parsed);
      skeleton.push(signature);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      addBinding(statement.name);
      if (statement.heritageClauses?.length || statement.modifiers?.some(modifier =>
        modifier.kind === ts.SyntaxKind.Decorator || modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        throw new Error("Hot patch class inheritance and decorators require explicit support.");
      }
      const members = [];
      const initialMembers = [];
      for (const member of statement.members) {
        if (member.name && ts.isPrivateIdentifier(member.name)) throw new Error("Hot patch private class fields require explicit support.");
        if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
          if (member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.Decorator)) throw new Error("Hot patch decorators require explicit support.");
          const static_ = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
          const id = `${statement.name.text}.${static_ ? "static." : ""}${member.name.text}`;
          functions.push({ declaration: member, id });
          members.push(ts.factory.updateMethodDeclaration(member, member.modifiers, member.asteriskToken, member.name,
            member.questionToken, member.typeParameters, member.parameters, member.type, ts.factory.createBlock([])));
          const body = ts.factory.createBlock([ts.factory.createReturnStatement(ts.factory.createCallExpression(
            ts.factory.createPropertyAccessExpression(ts.factory.createCallExpression(
              ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("__rabiPatchRuntime"), "bind"), undefined,
              [ts.factory.createStringLiteral(id), ts.factory.createIdentifier("__rabiPatchEnvironment")]), "apply"), undefined,
            [ts.factory.createThis(), ts.factory.createIdentifier("__rabiPatchArguments")]))]);
          initialMembers.push(ts.factory.createMethodDeclaration(member.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword),
            undefined, member.name, undefined, undefined,
            [ts.factory.createParameterDeclaration(undefined, ts.factory.createToken(ts.SyntaxKind.DotDotDotToken), "__rabiPatchArguments")], undefined, body));
        } else if (ts.isConstructorDeclaration(member) || ts.isPropertyDeclaration(member)) {
          members.push(member);
          initialMembers.push(member);
        } else {
          throw new Error("Unsupported hot patch class member.");
        }
      }
      skeleton.push(printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateClassDeclaration(statement,
        statement.modifiers, statement.name, statement.typeParameters, statement.heritageClauses, members), parsed));
      classes.set(statement, printer.printNode(ts.EmitHint.Unspecified, ts.factory.updateClassDeclaration(statement,
        undefined, statement.name, statement.typeParameters, undefined, initialMembers), parsed));
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        for (const declaration of statement.declarationList.declarations) dependencies.push(declaration.name.text);
      }
      if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) exported.push(declaration.name.text);
      }
      skeleton.push(printer.printNode(ts.EmitHint.Unspecified, statement, parsed));
    } else {
      throw new Error(`Unsupported hot patch module declaration: ${ts.SyntaxKind[statement.kind]}`);
    }
  }
  if (!functions.length) throw new Error("Hot patch module has no function implementations.");
  const implementations = {};
  const sourceMaps = {};
  for (const { declaration, id } of functions) {
    const transformed = ts.transform(declaration, [context => root => {
      const visitor = node => {
        if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isPrivateIdentifier(node)
          || ts.isMetaProperty(node) || ts.isWithStatement(node)
          || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
          || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")) {
          throw new Error("Hot patch function uses unsupported lexical runtime semantics.");
        }
        if (ts.isShorthandPropertyAssignment(node)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(node);
          const name = symbols.get(symbol);
          if (name) return ts.factory.createPropertyAssignment(node.name,
            ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("__rabiPatchEnvironment"), name));
        }
        if (ts.isIdentifier(node)) {
          const name = symbols.get(checker.getSymbolAtLocation(node));
          const parent = node.parent;
          const isName = (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent)
            || ts.isParameter(parent) || ts.isPropertyAccessExpression(parent)
            || ts.isPropertyAssignment(parent)) && parent.name === node;
          if (name && !isName && !ts.isTypeNode(parent)) {
            return ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("__rabiPatchEnvironment"), name);
          }
        }
        return ts.visitEachChild(node, visitor, context);
      };
      return ts.visitNode(root, visitor);
    }]);
    try {
      const fn = transformed.transformed[0];
      const expression = ts.factory.createFunctionExpression(
        fn.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword), fn.asteriskToken, undefined,
        fn.typeParameters, fn.parameters, fn.type, fn.body);
      const text = printer.printNode(ts.EmitHint.Expression, expression, parsed);
      const emitted = ts.transpileModule(
        `(__rabiPatchEnvironment, __rabiPatchReceiver, __rabiPatchArguments) => (${text}).apply(__rabiPatchReceiver, __rabiPatchArguments)`,
        { compilerOptions: { ...options, sourceMap: true, inlineSources: true }, fileName, sourceMap: true }
      );
      implementations[id] = emitted.outputText.replace(/\s*\/\/# sourceMappingURL=.*$/s, "").trim().replace(/;$/, "");
      if (!emitted.sourceMapText) throw new Error(`Source map generation failed for hot patch symbol: ${id}`);
      const sourceMap = JSON.parse(emitted.sourceMapText);
      sourceMap.file = `${id}.js`;
      sourceMap.sources = [path.basename(fileName)];
      sourceMap.sourcesContent = [source];
      sourceMaps[id] = Object.freeze(sourceMap);
    } finally { transformed.dispose(); }
  }
  const semantic = program.getSemanticDiagnostics(parsed);
  if (semantic.length) {
    throw new Error(ts.formatDiagnostics(semantic, {
      getCanonicalFileName: name => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n"
    }));
  }
  const typeDependencies = program.getSourceFiles()
    .filter(dependency => dependency !== parsed && !program.isSourceFileDefaultLibrary(dependency))
    .map(dependency => [path.relative(path.dirname(fileName), dependency.fileName).replaceAll("\\", "/"), digest(dependency.text)])
    .sort(([left], [right]) => left.localeCompare(right));
  const initialization = parsed.statements.flatMap(statement => {
    if (classes.has(statement)) return [classes.get(statement)];
    if (!ts.isVariableStatement(statement)) return [];
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return [];
    return [printer.printNode(ts.EmitHint.Unspecified,
      ts.factory.updateVariableStatement(statement, undefined, statement.declarationList), parsed)];
  }).join("\n");
  const environment = names.map(name => {
    const variable = parsed.statements.filter(ts.isVariableStatement).flatMap(statement =>
      statement.declarationList.declarations.map(declaration => ({ statement, declaration })))
      .find(item => item.declaration.name.text === name);
    const writable = variable && !(variable.statement.declarationList.flags & ts.NodeFlags.Const)
      && !dependencies.includes(name);
    return `${JSON.stringify(name)}:{get:()=>${name}${writable ? `,set:(value)=>{${name}=value}` : ""}}`;
  }).join(",");
  const initializationSource = ts.transpileModule(initialization, { compilerOptions: options, fileName }).outputText;
  return Object.freeze({
    schemaVersion: 1,
    sourceHash: digest(source),
    compatibilityHash: digest(JSON.stringify({ skeleton, typeDependencies })),
    implementations: Object.freeze(implementations),
    sourceMaps: Object.freeze(sourceMaps),
    dependencies: Object.freeze(dependencies),
    functionNames: Object.freeze(functionNames),
    initializationSource,
    environmentDescriptors: environment,
    exported: Object.freeze(exported)
  });
}

export function diffHotPatchModules(previous, next) {
  if (previous.compatibilityHash !== next.compatibilityHash) {
    throw new Error("Hot patch changes declarations, signatures or state initialization; an explicit module migration is required.");
  }
  return Object.entries(next.implementations).filter(([name, code]) => code !== previous.implementations[name])
    .map(([name, code]) => Object.freeze({ name, code }));
}
