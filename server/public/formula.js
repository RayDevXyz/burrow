/* Burrow formulas — a small, safe expression language inspired by Notion formulas.
 *
 *   prop("Price") * prop("Qty")
 *   if(prop("Done"), "✅", "⏳")
 *   dateBetween(prop("Due"), now(), "days") + " days left"
 *   prop("Title").length                (method style also works: x.upper(), x.contains("a"))
 *
 * Operators: + - * / % ^, == != > < >= <=, and or not, && || !, ? : , parentheses.
 * Never uses eval/Function: the expression is parsed to a tree and interpreted.
 */
(function (root) {
  'use strict';

  // ───────── tokenizer ─────────
  function tokenize(src) {
    const out = []; let i = 0;
    const two = ['==', '!=', '>=', '<=', '&&', '||'];
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c) && /[0-9]/.test(src[i + (c === '.' ? 1 : 0)] || '')) {
        const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i)); out.push({ t: 'num', v: +m[0] }); i += m[0].length; continue;
      }
      if (c === '"' || c === "'" || c === '“' || c === '”') {
        const close = c === '“' ? '”' : c; let j = i + 1, s = '';
        while (j < src.length && src[j] !== close && !(close === '”' && src[j] === '"')) {
          if (src[j] === '\\' && j + 1 < src.length) { s += { n: '\n', t: '\t' }[src[j + 1]] ?? src[j + 1]; j += 2; } else s += src[j++];
        }
        if (j >= src.length) throw new Error('Unclosed string');
        out.push({ t: 'str', v: s }); i = j + 1; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
      }
      const op = two.find(o => src.startsWith(o, i));
      if (op) { out.push({ t: 'op', v: op }); i += 2; continue; }
      if ('+-*/%^()<>,!?:.'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
      throw new Error(`Unexpected "${c}"`);
    }
    out.push({ t: 'eof' });
    return out;
  }

  // ───────── parser (precedence climbing) ─────────
  function parse(src) {
    const toks = tokenize(src); let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const isOp = v => peek().t === 'op' && peek().v === v;
    const isWord = v => peek().t === 'id' && peek().v.toLowerCase() === v;
    const expect = v => { if (!isOp(v)) throw new Error(`Expected "${v}"`); p++; };

    function ternary() {
      const c = or();
      if (isOp('?')) { p++; const a = ternary(); expect(':'); const b = ternary(); return { k: 'if', c, a, b }; }
      return c;
    }
    function or() { let l = and(); while (isOp('||') || isWord('or')) { p++; l = { k: 'or', l, r: and() }; } return l; }
    function and() { let l = not(); while (isOp('&&') || isWord('and')) { p++; l = { k: 'and', l, r: not() }; } return l; }
    function not() { if (isOp('!') || isWord('not')) { p++; return { k: 'not', e: not() }; } return cmp(); }
    function cmp() {
      let l = add();
      while (['==', '!=', '>', '<', '>=', '<='].some(isOp)) { const op = next().v; l = { k: 'bin', op, l, r: add() }; }
      return l;
    }
    function add() { let l = mul(); while (isOp('+') || isOp('-')) { const op = next().v; l = { k: 'bin', op, l, r: mul() }; } return l; }
    function mul() { let l = pow(); while (isOp('*') || isOp('/') || isOp('%')) { const op = next().v; l = { k: 'bin', op, l, r: pow() }; } return l; }
    function pow() { const l = unary(); if (isOp('^')) { p++; return { k: 'bin', op: '^', l, r: pow() }; } return l; }
    function unary() { if (isOp('-')) { p++; return { k: 'neg', e: unary() }; } if (isOp('+')) { p++; return unary(); } return postfix(); }
    function args() { const a = []; expect('('); if (!isOp(')')) { do { a.push(ternary()); } while (isOp(',') && ++p); } expect(')'); return a; }
    function postfix() {
      let e = primary();
      while (isOp('.')) {
        p++; const t = next(); if (t.t !== 'id') throw new Error('Expected a name after "."');
        e = isOp('(') ? { k: 'call', name: t.v, args: [e, ...args()] } : { k: 'call', name: t.v, args: [e] };
      }
      return e;
    }
    function primary() {
      const t = next();
      if (t.t === 'num') return { k: 'lit', v: t.v };
      if (t.t === 'str') return { k: 'lit', v: t.v };
      if (t.t === 'op' && t.v === '(') { const e = ternary(); expect(')'); return e; }
      if (t.t === 'id') {
        const w = t.v.toLowerCase();
        if (w === 'true') return { k: 'lit', v: true };
        if (w === 'false') return { k: 'lit', v: false };
        if (w === 'null' || w === 'empty' && !isOp('(')) return { k: 'lit', v: null };
        if (isOp('(')) return { k: 'call', name: t.v, args: args() };
        throw new Error(`Unknown name "${t.v}" — use prop("${t.v}") for properties`);
      }
      throw new Error(t.t === 'eof' ? 'Formula ends too early' : `Unexpected "${t.v}"`);
    }
    if (peek().t === 'eof') return { k: 'lit', v: null };
    const tree = ternary();
    if (peek().t !== 'eof') throw new Error(`Unexpected "${peek().v}"`);
    return tree;
  }

  // ───────── values & functions ─────────
  const isDate = v => v instanceof Date && !Number.isNaN(+v);
  const toNum = v => (isDate(v) ? +v : typeof v === 'boolean' ? +v : v == null || v === '' ? 0 : +v);
  const toStr = v => v == null ? '' : isDate(v) ? fmtDate(v) : Array.isArray(v) ? v.map(toStr).join(', ')
    : typeof v === 'number' ? String(Math.round(v * 1e10) / 1e10) : String(v);
  const truthy = v => Array.isArray(v) ? v.length > 0 : v instanceof Date ? true : !!v;
  const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'number' && Number.isNaN(v));
  const fmtDate = (d, f) => {
    const p = n => String(n).padStart(2, '0');
    if (f === 'iso' || f === 'YYYY-MM-DD') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + (d.getHours() || d.getMinutes() ? ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  };
  const UNIT = { years: 'y', year: 'y', y: 'y', months: 'M', month: 'M', M: 'M', weeks: 'w', week: 'w', w: 'w', days: 'd', day: 'd', d: 'd', hours: 'h', hour: 'h', h: 'h', minutes: 'm', minute: 'm', m: 'm' };
  const MS = { w: 6048e5, d: 864e5, h: 36e5, m: 6e4 };
  function dateAdd(d, n, unit) {
    if (!isDate(d)) return null; const u = UNIT[unit] || 'd'; const x = new Date(d);
    if (u === 'y') x.setFullYear(x.getFullYear() + n); else if (u === 'M') x.setMonth(x.getMonth() + n); else x.setTime(+x + n * MS[u]);
    return x;
  }
  function dateBetween(a, b, unit) {
    if (!isDate(a) || !isDate(b)) return null; const u = UNIT[unit] || 'd';
    if (u === 'y') return a.getFullYear() - b.getFullYear() - ((a.getMonth() < b.getMonth() || a.getMonth() === b.getMonth() && a.getDate() < b.getDate()) ? 1 : 0);
    if (u === 'M') return (a.getFullYear() - b.getFullYear()) * 12 + a.getMonth() - b.getMonth() - (a.getDate() < b.getDate() ? 1 : 0);
    return Math.trunc((a - b) / MS[u]);
  }
  const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

  const FN = {
    if: null, ifs: null, // lazy, handled in evaluate
    concat: (...a) => a.every(Array.isArray) ? [].concat(...a) : a.map(toStr).join(''),
    join: (list, sep = ', ') => (Array.isArray(list) ? list : [list]).map(toStr).join(toStr(sep)),
    length: v => Array.isArray(v) ? v.length : toStr(v).length,
    contains: (v, x) => Array.isArray(v) ? v.some(i => toStr(i).toLowerCase() === toStr(x).toLowerCase()) : toStr(v).toLowerCase().includes(toStr(x).toLowerCase()),
    test: (v, re) => { try { return new RegExp(toStr(re), 'i').test(toStr(v)); } catch { return false; } },
    replace: (v, a, b) => toStr(v).replace(toStr(a), toStr(b)),
    replaceAll: (v, a, b) => toStr(v).split(toStr(a)).join(toStr(b)),
    lower: v => toStr(v).toLowerCase(), upper: v => toStr(v).toUpperCase(), trim: v => toStr(v).trim(),
    substring: (v, a, b) => toStr(v).substring(toNum(a), b == null ? undefined : toNum(b)),
    slice: (v, a, b) => Array.isArray(v) ? v.slice(toNum(a), b == null ? undefined : toNum(b)) : toStr(v).slice(toNum(a), b == null ? undefined : toNum(b)),
    split: (v, sep) => toStr(v).split(toStr(sep)),
    repeat: (v, n) => toStr(v).repeat(Math.max(0, Math.min(1000, toNum(n)))),
    format: v => toStr(v), toString: v => toStr(v),
    toNumber: v => isDate(v) ? +v : typeof v === 'boolean' ? +v : parseFloat(toStr(v)),
    empty: v => isEmpty(v), isEmpty: v => isEmpty(v),
    abs: v => Math.abs(toNum(v)), sqrt: v => Math.sqrt(toNum(v)), cbrt: v => Math.cbrt(toNum(v)),
    round: (v, d = 0) => { const f = 10 ** toNum(d); return Math.round(toNum(v) * f) / f; },
    floor: v => Math.floor(toNum(v)), ceil: v => Math.ceil(toNum(v)), sign: v => Math.sign(toNum(v)),
    pow: (a, b) => toNum(a) ** toNum(b), exp: v => Math.exp(toNum(v)), ln: v => Math.log(toNum(v)), log10: v => Math.log10(toNum(v)),
    min: (...a) => Math.min(...a.flat().map(toNum)), max: (...a) => Math.max(...a.flat().map(toNum)),
    sum: (...a) => a.flat().reduce((s, x) => s + toNum(x), 0),
    mean: (...a) => { const f = a.flat(); return f.length ? f.reduce((s, x) => s + toNum(x), 0) / f.length : 0; },
    median: (...a) => { const f = a.flat().map(toNum).sort((x, y) => x - y); if (!f.length) return 0; const m = f.length >> 1; return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2; },
    first: v => Array.isArray(v) ? v[0] ?? null : v, last: v => Array.isArray(v) ? v[v.length - 1] ?? null : v,
    at: (v, i) => Array.isArray(v) ? v.at(toNum(i)) ?? null : toStr(v).at(toNum(i)) ?? null,
    unique: v => Array.isArray(v) ? [...new Set(v)] : v, sort: v => Array.isArray(v) ? [...v].sort() : v, reverse: v => Array.isArray(v) ? [...v].reverse() : toStr(v).split('').reverse().join(''),
    list: (...a) => a,
    now: () => new Date(), today: () => startOfDay(),
    date: v => { const d = isDate(v) ? v : new Date(toStr(v)); return isDate(d) ? d : null; },
    dateAdd: (d, n, u) => dateAdd(d, toNum(n), toStr(u)), dateSubtract: (d, n, u) => dateAdd(d, -toNum(n), toStr(u)),
    dateBetween: (a, b, u) => dateBetween(a, b, toStr(u)),
    formatDate: (d, f) => isDate(d) ? fmtDate(d, toStr(f)) : '',
    year: d => isDate(d) ? d.getFullYear() : null, month: d => isDate(d) ? d.getMonth() + 1 : null,
    day: d => isDate(d) ? d.getDay() : null, date_: null,
    hour: d => isDate(d) ? d.getHours() : null, minute: d => isDate(d) ? d.getMinutes() : null,
    timestamp: d => isDate(d) ? +d : null, fromTimestamp: n => new Date(toNum(n)),
    pi: () => Math.PI, e: () => Math.E,
    style: v => v, unstyle: v => v, // accepted for Notion compatibility, styling is ignored
  };
  delete FN.date_;

  function evaluate(node, ctx, depth = 0) {
    if (depth > 200) throw new Error('Formula is too deeply nested');
    const ev = n => evaluate(n, ctx, depth + 1);
    switch (node.k) {
      case 'lit': return node.v;
      case 'neg': return -toNum(ev(node.e));
      case 'not': return !truthy(ev(node.e));
      case 'and': return truthy(ev(node.l)) && truthy(ev(node.r));
      case 'or': return truthy(ev(node.l)) || truthy(ev(node.r));
      case 'if': return truthy(ev(node.c)) ? ev(node.a) : ev(node.b);
      case 'bin': {
        const a = ev(node.l), b = ev(node.r);
        switch (node.op) {
          case '+':
            if (isDate(a) && typeof b === 'number') return new Date(+a + b * 864e5);
            if (typeof a === 'string' || typeof b === 'string' || Array.isArray(a) || Array.isArray(b)) return toStr(a) + toStr(b);
            return toNum(a) + toNum(b);
          case '-': if (isDate(a) && isDate(b)) return Math.trunc((a - b) / 864e5); if (isDate(a)) return new Date(+a - toNum(b) * 864e5); return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': return toNum(b) === 0 ? null : toNum(a) / toNum(b);
          case '%': return toNum(a) % toNum(b);
          case '^': return toNum(a) ** toNum(b);
          case '==': return eq(a, b); case '!=': return !eq(a, b);
          case '>': return cmpv(a, b) > 0; case '<': return cmpv(a, b) < 0;
          case '>=': return cmpv(a, b) >= 0; case '<=': return cmpv(a, b) <= 0;
        }
        break;
      }
      case 'call': {
        const name = node.name;
        const lname = name.toLowerCase();
        if (lname === 'prop') return ctx.prop(toStr(ev(node.args[0])));
        if (lname === 'id') return ctx.id ? ctx.id() : null;
        if (lname === 'if') return truthy(ev(node.args[0])) ? ev(node.args[1]) : (node.args[2] ? ev(node.args[2]) : null);
        if (lname === 'ifs') { const a = node.args; for (let i = 0; i + 1 < a.length; i += 2) if (truthy(ev(a[i]))) return ev(a[i + 1]); return a.length % 2 ? ev(a[a.length - 1]) : null; }
        if (lname === 'and') return node.args.every(x => truthy(ev(x)));
        if (lname === 'or') return node.args.some(x => truthy(ev(x)));
        if (lname === 'not') return !truthy(ev(node.args[0]));
        // Only our own functions: never fall through to Object.prototype (constructor, __proto__, …)
        const key = Object.hasOwn(FN, name) ? name : Object.keys(FN).find(k => k.toLowerCase() === lname);
        const fn = key && typeof FN[key] === 'function' ? FN[key] : null;
        if (!fn) throw new Error(`Unknown function ${name}()`);
        return fn(...node.args.map(ev));
      }
    }
    throw new Error('Bad formula');
  }
  const eq = (a, b) => isDate(a) || isDate(b) ? +a === +b : Array.isArray(a) || Array.isArray(b) ? toStr(a) === toStr(b)
    : typeof a === 'number' || typeof b === 'number' ? toNum(a) === toNum(b) : toStr(a) === toStr(b);
  const cmpv = (a, b) => (typeof a === 'string' && typeof b === 'string') ? a.localeCompare(b) : toNum(a) - toNum(b);

  const cache = new Map();
  /** Compile once, run many times. Returns { run(ctx), error }. */
  function compile(src) {
    if (cache.has(src)) return cache.get(src);
    let out;
    try { const tree = parse(src || ''); out = { run: ctx => evaluate(tree, ctx), error: null }; }
    catch (e) { out = { run: () => { throw e; }, error: e.message }; }
    if (cache.size > 500) cache.clear();
    cache.set(src, out);
    return out;
  }

  const api = { compile, toStr, isDate, functions: Object.keys(FN).concat(['prop', 'if', 'ifs', 'and', 'or', 'not', 'id']).sort() };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.BurrowFormula = api;
})(typeof window !== 'undefined' ? window : globalThis);
