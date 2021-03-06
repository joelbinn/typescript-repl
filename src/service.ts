/// <reference path='../typings/node.d.ts' />
/// <reference path='../typings/colors.d.ts' />
/// <reference path='../typings/diff.d.ts' />

import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import * as diff from 'diff'
import {repl, defaultPrompt} from './repl'

const DUMMY_FILE = 'TSUN.repl.generated.ts'

// codes has been accepted by service, as opposed to codes in buffer and user input
// if some action fails to compile, acceptedCodes will be rolled-back
export var acceptedCodes = getInitialCommands()
// a counter indicating repl edition history, every action will increment it
var versionCounter = 0

function findConfigFile(searchPath: string) {
  while (true) {
    const fileName = path.join(searchPath, "tsconfig.json");
    if (fs.existsSync(fileName)) {
      return fileName;
    }
    const parentPath = path.dirname(searchPath);
    if (parentPath === searchPath) {
      break;
    }
    searchPath = parentPath;
  }
  return undefined;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES5,
  newLine: ts.NewLineKind.LineFeed,
  noEmitHelpers: true,
  experimentalDecorators: true
}

function compileOption(): () => ts.CompilerOptions {
  let configFile = findConfigFile(process.cwd())
  if (!configFile) {
    return () => DEFAULT_OPTIONS
  }

  let configText = fs.readFileSync(configFile, 'utf8')
  let result = ts.parseConfigFileTextToJson(configFile, configText)
  if (result.error) {
    return () => DEFAULT_OPTIONS
  }
  let optionsRet = ts.convertCompilerOptionsFromJson(
    result.config.compilerOptions,
    path.dirname(configFile)
  )
  if (optionsRet.errors.length) {
    return () => DEFAULT_OPTIONS
  }
  let options = optionsRet.options

  options['noEmitHelpers'] = true
  options['module'] = ts.ModuleKind.CommonJS
  return () => options
}

var serviceHost: ts.LanguageServiceHost = {
  getCompilationSettings: compileOption(),
  getScriptFileNames: () => [DUMMY_FILE],
  getScriptVersion: (fileName) => {
    return fileName === DUMMY_FILE && versionCounter.toString()
  },
  getScriptSnapshot: (fileName) => {
    try {
      var text = fileName === DUMMY_FILE
        ? acceptedCodes
        : fs.readFileSync(fileName).toString()
      return ts.ScriptSnapshot.fromString(text)
    } catch(e) {

    }
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (options) => path.join(__dirname, '../../node_modules/typescript/lib/lib.core.es6.d.ts')
}

var service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry())

export var getDeclarations = (function() {
  var declarations: {[fileName: string]: {[name: string]: ts.DeclarationName[]}} = {}
  let declFiles = getDeclarationFiles().concat(path.join(__dirname, '../../node_modules/typescript/lib/lib.core.es6.d.ts'))
  for (let file of declFiles) {
    let text = fs.readFileSync(file, 'utf8')
    declarations[file] = collectDeclaration(ts.createSourceFile(file, text, ts.ScriptTarget.Latest))
  }
  return function(cached: boolean = false) {
    if (!cached) {
      declarations[DUMMY_FILE] = collectDeclaration(ts.createSourceFile(DUMMY_FILE, acceptedCodes, ts.ScriptTarget.Latest))
    }
    return declarations
  }
})()

function getDeclarationFiles() {
  var libPaths = [path.resolve(__dirname, '../../typings/node.d.ts')]
  try {
    let typings = path.join(process.cwd(), './typings')
    let dirs = fs.readdirSync(typings)
    for (let dir of dirs) {
      if (!/\.d\.ts$/.test(dir)) continue
      let p = path.join(typings, dir)
      if (fs.statSync(p).isFile()) {
        libPaths.push(p)
      }
    }
  } catch(e) {
  }
  return libPaths
}

function getInitialCommands() {
  var codes = getDeclarationFiles().map(dir => `/// <reference path="${dir}" />`)
  return codes.join('\n')
}

// private api hacks
function collectDeclaration(sourceFile: any): any {
  let decls = sourceFile.getNamedDeclarations()
  var ret: any = {}
  for (let decl in decls) {
    ret[decl] = decls[decl].map((t: any) => t.name)
  }
  return ret
}

function getMemberInfo(member: ts.ClassElement, file: string, parentDeclaration: any): string {
  // member info is stored as the first
  let pos = member.getStart()
  let quickInfo = service.getQuickInfoAtPosition(file, pos)
  if (quickInfo) return ts.displayPartsToString(quickInfo.displayParts)
  // DeclarationName includes Identifier which does not have name and will not go here
  let name = member.name && member.name.getText()
  if (!name) return member.getText()
  let declarations = getDeclarations(true)[file][name]
  for (let decl of declarations) {
    let d: any = decl
    if (parentDeclaration.parent.name.getText() == d.parent.parent.name.getText()) {
      let quickInfo = service.getQuickInfoAtPosition(file, d.getEnd())
      return ts.displayPartsToString(quickInfo.displayParts)
    }
  }
  return member.getText()
}

function getTypeInfo(decl: ts.Node, file: string, detailed: boolean): string[] {
  // getStart will count comment
  let pos = decl.getEnd()
  let ret = [`declaration in: ${file}`]
  let quickInfo = service.getQuickInfoAtPosition(file, pos)
  ret.push(ts.displayPartsToString(quickInfo.displayParts))
  if (!detailed) return ret
  let parentName = ret[1].split(' ')[1]
  let symbolType = quickInfo.displayParts[0].text
  if ( symbolType === 'interface' || symbolType === 'class') {
    let classLikeDeclaration = <ts.ClassLikeDeclaration>decl.parent
    for (let member of classLikeDeclaration.members) {
      let memberInfo = getMemberInfo(member, file, decl).split('\n').map(mInfo => {
        mInfo = mInfo.replace(new RegExp(parentName + '\\.', 'g'), '')
        return '    ' + mInfo
      })
      ret.push(memberInfo.join('\n'))
    }
  }
  return ret

}


export function completer(line: string) {
  // append new line to get completions, then revert new line
  versionCounter++
  let originalCodes = acceptedCodes
  acceptedCodes += line
  if (':' === line[0]) {
    let candidates = ['type', 'detail', 'source', 'paste', 'clear', 'print', 'help']
    candidates = candidates.map(c => ':' + c).filter(c => c.indexOf(line) >= 0)
    return [candidates, line.trim()]
  }
  let completions = service.getCompletionsAtPosition(DUMMY_FILE, acceptedCodes.length)
  if (!completions) {
    acceptedCodes = originalCodes
    return [[], line]
  }
  let prefix = /[A-Za-z_$]+$/.exec(line)
  let candidates: string[] = []
  if (prefix) {
    let prefixStr = prefix[0]
    candidates = completions.entries.filter((entry) => {
      let name = entry.name
      return name.substr(0, prefixStr.length) == prefixStr
    }).map(entry => entry.name)
  } else {
    candidates = completions.entries.map(entry => entry.name)
  }
  acceptedCodes = originalCodes
  return [candidates, prefix ? prefix[0] : line]
}

export function getType(name: string, detailed: boolean) {
  let declarations = getDeclarations()
  for (let file in declarations) {
    let names = declarations[file]
    if (names[name]) {
      let decl = names[name][0]
      let infoString = getTypeInfo(decl, file, detailed)
      console.log(infoString.join('\n').cyan)
      return
    }
  }
  console.log(`identifier ${name} not found`.yellow)
}

export function getDiagnostics(code: string): string[] {
  let allDiagnostics = service.getCompilerOptionsDiagnostics()
    .concat(service.getSemanticDiagnostics(DUMMY_FILE))

  let fallback = acceptedCodes
  acceptedCodes += code
  versionCounter++
  let ret = allDiagnostics.map(diagnostic => {
    let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    return message
  })
  if (ret.length) acceptedCodes = fallback
  return ret
}

let lastOutput = ''
export function getCurrentCode() {
  let emit = service.getEmitOutput(DUMMY_FILE)
  let output = emit.outputFiles[0].text
  let changes = diff.diffLines(lastOutput, output)
  let ret = changes.filter(c => c.added).map(c => c.value).join('\n')
  lastOutput = output
  return ret
}

export function testSyntacticError(code: string) {
  let fallback = acceptedCodes
  versionCounter++
  acceptedCodes += code
  let diagnostics = service.getSyntacticDiagnostics(DUMMY_FILE)
  acceptedCodes = fallback
  return diagnostics
}

export function clearHistory() {
  acceptedCodes = getInitialCommands()
  lastOutput = ''
}
