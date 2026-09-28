'use strict';

// Тонкая обёртка над встроенным в Node драйвером node:sqlite.
//
// Почему не better-sqlite3: это нативный модуль, ему нужен компилятор при
// установке. На серверах с 1 vCPU и 700 МБ RAM компиляция — это лишние
// минуты и риск упасть посреди установки, а node:sqlite уже входит в Node
// и ставится нулём действий.
//
// Весь SQL в проекте использует позиционные плейсхолдеры `?`. Именованные
// (`@name`) намеренно не поддержаны: node:sqlite принимает объект, но
// тогда порядок ключей молча становится порядком аргументов, и любая
// опечатка в SQL проходит незамеченной до времени выполнения. Позиционные
// `?` ошибиться так не дают.

const { DatabaseSync } = require('node:sqlite');

// .run(a, b) и .run([a, b]) означают одно и то же; без аргументов — пусто.
function flatten(args) {
  if (args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

class Statement {
  constructor(stmt) {
    this.stmt = stmt;
  }

  get(...args) {
    return this.stmt.get(...flatten(args));
  }

  all(...args) {
    return this.stmt.all(...flatten(args));
  }

  run(...args) {
    return this.stmt.run(...flatten(args));
  }
}

class Database {
  constructor(filename) {
    this.raw = new DatabaseSync(filename);
  }

  pragma(text) {
    this.raw.exec(`PRAGMA ${text}`);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  prepare(sql) {
    return new Statement(this.raw.prepare(sql));
  }

  /**
   * Синхронная транзакция. Вложенных вызовов в проекте нет, поэтому
   * достаточно BEGIN/COMMIT/ROLLBACK без учёта глубины.
   */
  transaction(fn) {
    return (...args) => {
      this.raw.exec('BEGIN');
      try {
        const out = fn(...args);
        this.raw.exec('COMMIT');
        return out;
      } catch (e) {
        try { this.raw.exec('ROLLBACK'); } catch (_) { /* уже откатилось */ }
        throw e;
      }
    };
  }

  close() {
    try { this.raw.close(); } catch (_) { /* уже закрыта */ }
  }
}

module.exports = { Database, Statement };
