import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import ts from 'typescript';
import { type Tool, err, ok } from './types.ts';

type Action = 'symbols' | 'definition' | 'references' | 'diagnostics';

export const codeIntelTool: Tool = {
  name: 'CodeIntel',
  description:
    'Project-aware code intelligence. Finds symbols, definitions, references, or runs TypeScript diagnostics.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['symbols', 'definition', 'references', 'diagnostics'],
        description: 'Code-intelligence operation to run.',
      },
      query: {
        type: 'string',
        description: 'Symbol or regex to search for. Not required for diagnostics.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to inspect. Defaults to the current working directory.',
      },
      file: {
        type: 'string',
        description: 'Source file for language-service operations.',
      },
      line: {
        type: 'number',
        description: '1-based line number for definition/reference lookup.',
      },
      character: {
        type: 'number',
        description: '1-based character column for definition/reference lookup.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(input, opts) {
    const action = input['action'] as Action;
    const query = typeof input['query'] === 'string' ? input['query'].trim() : '';
    const path =
      typeof input['path'] === 'string' && input['path'].trim() ? input['path'].trim() : '.';
    const file =
      typeof input['file'] === 'string' && input['file'].trim() ? input['file'].trim() : undefined;
    const line = typeof input['line'] === 'number' ? input['line'] : undefined;
    const character = typeof input['character'] === 'number' ? input['character'] : undefined;

    if (!['symbols', 'definition', 'references', 'diagnostics'].includes(action)) {
      return err('action must be one of: symbols, definition, references, diagnostics');
    }
    const hasPosition = !!file && line !== undefined && character !== undefined;
    if (
      action !== 'diagnostics' &&
      !(action === 'symbols' && file) &&
      !((action === 'definition' || action === 'references') && hasPosition) &&
      !query
    ) {
      return err('query is required');
    }

    if (action === 'diagnostics') return diagnostics(path, file, opts?.signal);
    if (
      (action === 'definition' || action === 'references') &&
      file &&
      line !== undefined &&
      character !== undefined
    ) {
      return languageServiceLookup(action, file, line, character);
    }
    if (action === 'symbols' && file) return languageServiceSymbols(file);
    if (action === 'symbols') {
      return rg(
        [
          '--line-number',
          '--no-heading',
          '--color=never',
          '--glob',
          '!node_modules',
          '--glob',
          '!dist',
          symbolPattern(query),
          path,
        ],
        opts?.signal,
      );
    }
    if (action === 'definition') {
      return rg(
        [
          '--line-number',
          '--no-heading',
          '--color=never',
          '--glob',
          '!node_modules',
          '--glob',
          '!dist',
          definitionPattern(query),
          path,
        ],
        opts?.signal,
      );
    }
    return rg(
      [
        '--line-number',
        '--no-heading',
        '--color=never',
        '--glob',
        '!node_modules',
        '--glob',
        '!dist',
        escapeRegex(query),
        path,
      ],
      opts?.signal,
    );
  },
};

async function rg(args: string[], signal?: AbortSignal) {
  try {
    const baseOpts = { reject: false as const, encoding: 'utf8' as const };
    const execOpts = signal ? { ...baseOpts, cancelSignal: signal } : baseOpts;
    const result = await execa('rg', args, execOpts);
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.exitCode === 1 && !stderr) return ok('(no matches)');
    const out = stdout || stderr || '';
    return ok(truncate(out));
  } catch (e) {
    return err(`CodeIntel search failed: ${(e as Error).message}`);
  }
}

function languageServiceLookup(
  action: 'definition' | 'references',
  file: string,
  line: number,
  character: number,
) {
  try {
    const service = createLanguageService(file);
    const source = service.program.getSourceFile(service.fileName);
    if (!source) return err(`file not found in TypeScript program: ${service.fileName}`);
    const position = ts.getPositionOfLineAndCharacter(source, line - 1, character - 1);
    const items =
      action === 'definition'
        ? (service.languageService.getDefinitionAtPosition(service.fileName, position) ?? [])
        : (service.languageService.findReferences(service.fileName, position) ?? []).flatMap(
            (ref) => ref.references,
          );
    if (items.length === 0) return ok('(no results)');
    const lines = items.map((item) => {
      const targetFile = item.fileName;
      const targetSource = service.program.getSourceFile(targetFile);
      if (!targetSource) return `${targetFile}: ${item.textSpan.start}`;
      const pos = targetSource.getLineAndCharacterOfPosition(item.textSpan.start);
      const text = targetSource.text
        .slice(item.textSpan.start, item.textSpan.start + item.textSpan.length)
        .split('\n')[0]
        ?.trim();
      return `${targetFile}:${pos.line + 1}:${pos.character + 1}${text ? `  ${text}` : ''}`;
    });
    return ok(truncate(lines.join('\n')));
  } catch (e) {
    return err(`TypeScript language service failed: ${(e as Error).message}`);
  }
}

function languageServiceSymbols(file: string) {
  try {
    const service = createLanguageService(file);
    const tree = service.languageService.getNavigationTree(service.fileName);
    const lines: string[] = [];
    const visit = (item: ts.NavigationTree, depth: number) => {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}${item.kind} ${item.text}`);
      for (const child of item.childItems ?? []) visit(child, depth + 1);
    };
    visit(tree, 0);
    return ok(lines.join('\n'));
  } catch (e) {
    return err(`TypeScript language service failed: ${(e as Error).message}`);
  }
}

async function diagnostics(path: string, file?: string, signal?: AbortSignal) {
  if (file) {
    try {
      const service = createLanguageService(file);
      const diagnostics = [
        ...service.languageService.getSyntacticDiagnostics(service.fileName),
        ...service.languageService.getSemanticDiagnostics(service.fileName),
      ];
      if (diagnostics.length === 0) return ok('diagnostics passed');
      return err(formatTsDiagnostics(diagnostics));
    } catch (e) {
      return err(`TypeScript language service failed: ${(e as Error).message}`);
    }
  }
  const cwd = path === '.' ? process.cwd() : path;
  const packageJsonPath = join(cwd, 'package.json');
  const tsconfigPath = join(cwd, 'tsconfig.json');
  const baseOpts = { reject: false as const, encoding: 'utf8' as const, cwd };
  const execOpts = signal ? { ...baseOpts, cancelSignal: signal } : baseOpts;

  try {
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.['typecheck']) {
        const result = await execa('bun', ['run', 'typecheck'], execOpts);
        return formatDiagnosticResult(result.exitCode ?? 0, result.stdout, result.stderr);
      }
    }
    if (!existsSync(tsconfigPath))
      return ok('(no package typecheck script or tsconfig.json found)');
    const result = await execa('tsc', ['--noEmit', '--pretty', 'false'], execOpts);
    return formatDiagnosticResult(result.exitCode ?? 0, result.stdout, result.stderr);
  } catch (e) {
    return err(`diagnostics failed: ${(e as Error).message}`);
  }
}

interface TsService {
  fileName: string;
  program: ts.Program;
  languageService: ts.LanguageService;
}

function createLanguageService(file: string): TsService {
  const fileName = resolve(file);
  if (!existsSync(fileName)) throw new Error(`file not found: ${fileName}`);
  const configPath = ts.findConfigFile(dirname(fileName), ts.sys.fileExists, 'tsconfig.json');
  const config = configPath
    ? readTsConfig(configPath)
    : {
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          allowJs: true,
        },
        fileNames: [fileName],
      };
  const files = new Map<string, { version: string }>();
  for (const name of config.fileNames) files.set(resolve(name), { version: '0' });
  if (!files.has(fileName)) files.set(fileName, { version: '0' });
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (name) => files.get(resolve(name))?.version ?? '0',
    getScriptSnapshot: (name) => {
      if (!existsSync(name)) return undefined;
      return ts.ScriptSnapshot.fromString(readFileSync(name, 'utf8'));
    },
    getCurrentDirectory: () => dirname(configPath ?? fileName),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const languageService = ts.createLanguageService(host, ts.createDocumentRegistry());
  const program = languageService.getProgram();
  if (!program) throw new Error('could not create TypeScript program');
  return { fileName, program, languageService };
}

function readTsConfig(configPath: string): ts.ParsedCommandLine {
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(formatTsDiagnostics(parsed.errors));
  }
  return parsed;
}

function formatTsDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return truncate(
    diagnostics
      .map((d) => {
        const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        if (!d.file || d.start === undefined) return msg;
        const pos = d.file.getLineAndCharacterOfPosition(d.start);
        return `${d.file.fileName}:${pos.line + 1}:${pos.character + 1} TS${d.code}: ${msg}`;
      })
      .join('\n'),
  );
}

function formatDiagnosticResult(exitCode: number, stdout: string, stderr: string) {
  const out = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (exitCode === 0) return ok(out || 'diagnostics passed');
  return err(truncate(out || `diagnostics failed with exit code ${exitCode}`));
}

function symbolPattern(query: string): string {
  if (query === '*') {
    return String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+[A-Za-z0-9_$]+`;
  }
  return definitionPattern(query);
}

function definitionPattern(query: string): string {
  const q = escapeRegex(query);
  return String.raw`^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|enum)\s+${q}\b`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(value: string): string {
  return value.length > 30000 ? `${value.slice(0, 30000)}\n[truncated]` : value;
}
