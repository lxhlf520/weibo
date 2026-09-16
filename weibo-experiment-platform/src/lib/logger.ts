/**
 * 文件日志模块
 * ============================================================================
 * 同时输出到控制台 + 按天滚动的日志文件（logs/ 目录）。
 * 确保调度器后台运行时所有关键信息可回溯。
 */
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

// 确保 logs 目录存在
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeStr(): string {
  return new Date().toLocaleString();
}

function getLogFile(name: string): string {
  return path.join(LOG_DIR, `${name}-${todayStr()}.log`);
}

function writeLine(filePath: string, level: string, msg: string): void {
  const line = `[${timeStr()}] [${level}] ${msg}\n`;
  try {
    fs.appendFileSync(filePath, line, 'utf-8');
  } catch {
    // 写文件失败不阻塞主流程
  }
}

export interface Logger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function createLogger(name: string): Logger {
  const logFile = getLogFile(name);

  return {
    log(msg: string) {
      const line = `[${timeStr()}] ${msg}`;
      console.log(line);
      writeLine(logFile, 'INFO', msg);
    },
    warn(msg: string) {
      const line = `⚠️ ${msg}`;
      console.warn(line);
      writeLine(logFile, 'WARN', msg);
    },
    error(msg: string, err?: unknown) {
      const errStr = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err ?? '');
      const full = errStr ? `${msg}: ${errStr}` : msg;
      console.error(`❌ ${full}`);
      writeLine(logFile, 'ERROR', full);
    },
  };
}

// 全局单例
export const schedulerLog = createLogger('scheduler');
export const collectorLog = createLogger('collector');
export const apiLog = createLogger('api');
export const commenterLog = createLogger('commenter');
export const monitorLog = createLogger('monitor');
export const analyzerLog = createLogger('analyzer');
