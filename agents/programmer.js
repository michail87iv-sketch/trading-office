'use strict';

require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

// ─── Constants ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MAX_TURNS    = 30;

// Commands the programmer is allowed to run (prefix whitelist)
const SAFE_CMD_PREFIXES = [
  'node ', 'node -e ', 'npm install', 'npm list',
  'npm run', 'cat ', 'ls ', 'find ',
];

// ─── Anthropic client ─────────────────────────────────────────────────────────

const claude = new Anthropic();

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the project.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root (e.g. agents/sniper.js)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the project. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to project root',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to project root. Use "." for root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a pattern (substring or regex) across project files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search string or regex pattern',
        },
        file_glob: {
          type: 'string',
          description: 'Glob to filter files, e.g. "*.js". Defaults to "**/*.js".',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a safe shell command (node, npm, ls, find, cat). No destructive commands.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute from the project root',
        },
      },
      required: ['command'],
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────

function safeProjectPath(relPath) {
  const abs = path.resolve(PROJECT_ROOT, relPath);
  if (!abs.startsWith(PROJECT_ROOT)) {
    throw new Error(`Path escape attempt blocked: ${relPath}`);
  }
  return abs;
}

function executeTool(name, input) {
  switch (name) {
    case 'read_file': {
      const abs = safeProjectPath(input.path);
      if (!fs.existsSync(abs)) return `File not found: ${input.path}`;
      const content = fs.readFileSync(abs, 'utf8');
      return content.length > 12000
        ? content.slice(0, 12000) + `\n... [truncated — ${content.length} total bytes]`
        : content;
    }

    case 'write_file': {
      const abs = safeProjectPath(input.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.content, 'utf8');
      return `✓ Written: ${input.path} (${input.content.length} bytes)`;
    }

    case 'list_directory': {
      const abs = safeProjectPath(input.path);
      if (!fs.existsSync(abs)) return `Directory not found: ${input.path}`;
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`);
      return lines.join('\n') || '(empty)';
    }

    case 'search_code': {
      const glob   = input.file_glob || '**/*.js';
      const pattern = input.pattern;
      try {
        const result = execSync(
          `grep -rn --include="${glob}" -m 5 "${pattern.replace(/"/g, '\\"')}" .`,
          { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 8000 }
        );
        return result.slice(0, 3000) || 'No matches found.';
      } catch (e) {
        return e.stdout?.slice(0, 3000) || 'No matches found.';
      }
    }

    case 'run_command': {
      const cmd = input.command.trim();
      const allowed = SAFE_CMD_PREFIXES.some((p) => cmd.startsWith(p));
      if (!allowed) {
        return `Command blocked. Allowed prefixes: ${SAFE_CMD_PREFIXES.join(', ')}`;
      }
      try {
        const out = execSync(cmd, {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          timeout: 30000,
        });
        return out.slice(0, 3000) || '(no output)';
      } catch (e) {
        return `Error: ${e.message}\n${(e.stdout || '').slice(0, 1000)}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Ты PROGRAMMER — опытный Node.js разработчик, работающий в системе алготрейдинга на Bitget фьючерсах.

Стек проекта:
  - Node.js, CommonJS (require/module.exports)
  - @anthropic-ai/sdk для AI
  - telegraf v4 для Telegram
  - node-cron для задач по расписанию
  - axios для HTTP
  - dotenv для конфигурации

Структура проекта:
  agents/   — один файл на агента (admin.js, screener.js, sniper.js, и т.д.)
  core/     — общие модули (telegram.js, bitget.js, risk.js, cache.js)
  utils/    — утилиты (format.js)
  index.js  — точка входа

Конвенции:
  - Всегда 'use strict' в начале файла
  - Комментарии и console.log только на английском
  - Все денежные значения в USD, 2 знака после запятой
  - Временные метки: Unix seconds (Date.now() / 1000 | 0)
  - Никогда не логировать секреты или API-ключи
  - Минимальный RR 1:3 перед любым выполнением сделки
  - module.exports в конце каждого файла

При написании кода:
  1. Сначала изучи существующий код (read_file, list_directory)
  2. Пиши полные, рабочие файлы — не заглушки
  3. Следуй существующим паттернам в codebase
  4. Когда закончишь — кратко опиши что сделал и какие файлы создал/изменил`;

// ─── Progress callback type ────────────────────────────────────────────────────
// onProgress(text: string) — called with interim status messages

// ─── Main execute function ────────────────────────────────────────────────────

/**
 * Execute a coding task autonomously.
 *
 * @param {string} task          - Natural language task description
 * @param {object} [opts]
 * @param {function} [opts.onProgress]  - Called with status strings during work
 * @param {string}   [opts.context]     - Extra context (e.g. error stack)
 * @returns {Promise<{summary: string, filesChanged: string[], error: string|null}>}
 */
async function execute(task, opts = {}) {
  const { onProgress = () => {} } = opts;

  const messages = [
    { role: 'user', content: task },
  ];

  const filesChanged = [];
  let   turns        = 0;

  onProgress('🔧 PROGRAMMER запущен. Анализирую задачу...');

  while (turns < MAX_TURNS) {
    turns++;

    // Use streaming for long code generation
    const stream = claude.messages.stream({
      model:      'claude-opus-4-6',
      max_tokens: 8192,
      thinking:   { type: 'adaptive' },
      system:     SYSTEM_PROMPT,
      tools:      TOOLS,
      messages,
    });

    // Collect streamed text for progress (don't spam, just collect)
    let   streamedText = '';
    stream.on('text', (delta) => { streamedText += delta; });

    const response = await stream.finalMessage();

    // Append the full content to preserve tool_use blocks
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      // Final answer — extract summary from last text block
      const summary = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { summary: summary || 'Task completed.', filesChanged, error: null };
    }

    if (response.stop_reason !== 'tool_use') {
      return {
        summary:      '',
        filesChanged,
        error: `Unexpected stop_reason: ${response.stop_reason}`,
      };
    }

    // Execute all tool calls
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults   = [];

    for (const block of toolUseBlocks) {
      const { id, name, input } = block;

      // Track which files were touched
      if (name === 'write_file') {
        if (!filesChanged.includes(input.path)) filesChanged.push(input.path);
        onProgress(`📝 Записываю файл: ${input.path}`);
      } else if (name === 'read_file') {
        onProgress(`📖 Читаю: ${input.path}`);
      } else if (name === 'run_command') {
        onProgress(`⚙️ Выполняю: ${input.command}`);
      }

      let result;
      try {
        result = executeTool(name, input);
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }

      toolResults.push({
        type:        'tool_result',
        tool_use_id: id,
        content:     String(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    summary:      '',
    filesChanged,
    error: `Reached max turns (${MAX_TURNS}) without completing task.`,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { execute };
