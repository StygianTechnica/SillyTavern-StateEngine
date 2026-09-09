// State Engine — Tiny Expression DSL (calculated variables)
//
// Implements docs/TINY EXPRESSION DSL SPECIFICATION.md: a small,
// deterministic, side-effect-free expression language used to evaluate
// calculated variables. Pure - never mutates state, never performs I/O,
// never accesses anything outside the `values` map passed in. Never throws
// past evaluateExpression()'s own boundary; every failure comes back as
// { ok: false, error } so the caller (calculated-engine.js) can retain the
// variable's previous stored value per the DSL's own error-handling model
// (section 10.3).

// ---------------------------------------------------------------------------
// 1. Tokenizer
// ---------------------------------------------------------------------------

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    const n = expr.length;

    while (i < n) {
        const c = expr[i];

        if (/\s/.test(c)) { i++; continue; }

        // Strings: single or double quoted, \" and \\ are the only escapes
        // (spec 3.2). Applied symmetrically for either quote character.
        if (c === '"' || c === "'") {
            const quote = c;
            let j = i + 1;
            let out = '';
            while (j < n && expr[j] !== quote) {
                if (expr[j] === '\\' && j + 1 < n && (expr[j + 1] === quote || expr[j + 1] === '\\')) {
                    out += expr[j + 1];
                    j += 2;
                    continue;
                }
                out += expr[j];
                j++;
            }
            if (j >= n) throw new Error('Unterminated string literal');
            tokens.push({ type: 'string', value: out });
            i = j + 1;
            continue;
        }

        // Numbers: integers or floats (spec 3.2). Sign is handled by the
        // unary "-" operator, not the lexer.
        if (/[0-9]/.test(c)) {
            let j = i;
            while (j < n && /[0-9]/.test(expr[j])) j++;
            if (expr[j] === '.' && /[0-9]/.test(expr[j + 1] || '')) {
                j++;
                while (j < n && /[0-9]/.test(expr[j])) j++;
            }
            tokens.push({ type: 'number', value: Number(expr.slice(i, j)) });
            i = j;
            continue;
        }

        // Identifiers / keywords (spec 3.1, 3.2)
        if (/[A-Za-z_]/.test(c)) {
            let j = i;
            while (j < n && /[A-Za-z0-9_]/.test(expr[j])) j++;
            const word = expr.slice(i, j);
            if (word === 'true') tokens.push({ type: 'bool', value: true });
            else if (word === 'false') tokens.push({ type: 'bool', value: false });
            else if (word === 'null') tokens.push({ type: 'null', value: null });
            else tokens.push({ type: 'ident', value: word });
            i = j;
            continue;
        }

        // Two-character operators before their single-character prefixes.
        const two = expr.slice(i, i + 2);
        if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) {
            tokens.push({ type: 'op', value: two });
            i += 2;
            continue;
        }

        if ('+-*/%<>!().,?:'.includes(c)) {
            tokens.push({ type: 'op', value: c });
            i++;
            continue;
        }

        throw new Error(`Unexpected character "${c}" at position ${i}`);
    }

    tokens.push({ type: 'eof' });
    return tokens;
}

// ---------------------------------------------------------------------------
// 2. Parser (recursive descent, precedence per spec section 5, all binary
//    operators left-associative)
// ---------------------------------------------------------------------------

class Parser {
    constructor(tokens) {
        this.tokens = tokens;
        this.pos = 0;
    }

    peek() { return this.tokens[this.pos]; }
    next() { return this.tokens[this.pos++]; }

    isOp(value) {
        const t = this.peek();
        return t.type === 'op' && t.value === value;
    }

    expectOp(value) {
        const t = this.next();
        if (t.type !== 'op' || t.value !== value) throw new Error(`Expected "${value}"`);
        return t;
    }

    parse() {
        const node = this.parseOr();
        if (this.peek().type !== 'eof') throw new Error('Unexpected trailing input');
        return node;
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.isOp('||')) {
            this.next();
            left = { kind: 'logical', op: '||', left, right: this.parseAnd() };
        }
        return left;
    }

    parseAnd() {
        let left = this.parseTernary();
        while (this.isOp('&&')) {
            this.next();
            left = { kind: 'logical', op: '&&', left, right: this.parseTernary() };
        }
        return left;
    }

    // condition ? thenExpr : elseExpr - its own precedence tier, between
    // Equality and Logical AND (spec section 5 / 4.5). Not right-recursive:
    // each of condition/thenExpr/elseExpr is exactly one Equality-level
    // expression, the same shape every other tier in this parser has - a
    // nested ternary in a branch position needs explicit parentheses
    // (parentheses always re-enter parseOr() from parsePrimary(), so
    // `a ? b : (c ? d : e)` works; a bare `a ? b : c ? d : e` does not,
    // consistent with ternary binding *tighter* than && / || here rather
    // than the C/JS convention of binding loosest).
    parseTernary() {
        const condition = this.parseEquality();
        if (!this.isOp('?')) return condition;

        this.next();
        const thenExpr = this.parseEquality();
        this.expectOp(':');
        const elseExpr = this.parseEquality();
        return { kind: 'ternary', condition, thenExpr, elseExpr };
    }

    parseEquality() {
        let left = this.parseComparison();
        while (this.isOp('==') || this.isOp('!=')) {
            const op = this.next().value;
            left = { kind: 'compare', op, left, right: this.parseComparison() };
        }
        return left;
    }

    parseComparison() {
        let left = this.parseAdditive();
        while (this.isOp('<') || this.isOp('<=') || this.isOp('>') || this.isOp('>=')) {
            const op = this.next().value;
            left = { kind: 'compare', op, left, right: this.parseAdditive() };
        }
        return left;
    }

    parseAdditive() {
        let left = this.parseMultiplicative();
        while (this.isOp('+') || this.isOp('-')) {
            const op = this.next().value;
            left = { kind: 'arith', op, left, right: this.parseMultiplicative() };
        }
        return left;
    }

    parseMultiplicative() {
        let left = this.parseUnary();
        while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
            const op = this.next().value;
            left = { kind: 'arith', op, left, right: this.parseUnary() };
        }
        return left;
    }

    parseUnary() {
        if (this.isOp('-')) {
            this.next();
            return { kind: 'neg', operand: this.parseUnary() };
        }
        if (this.isOp('!')) {
            this.next();
            return { kind: 'not', operand: this.parseUnary() };
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let node = this.parsePrimary();
        while (this.isOp('.')) {
            this.next();
            const nameTok = this.next();
            if (nameTok.type !== 'ident') throw new Error('Expected a property or method name after "."');
            const name = nameTok.value;

            if (this.isOp('(')) {
                this.next();
                const args = [];
                if (!this.isOp(')')) {
                    args.push(this.parseOr());
                    while (this.isOp(',')) {
                        this.next();
                        args.push(this.parseOr());
                    }
                }
                this.expectOp(')');
                node = { kind: 'call', target: node, method: name, args };
            } else {
                node = { kind: 'prop', target: node, prop: name };
            }
        }
        return node;
    }

    parsePrimary() {
        const t = this.peek();
        if (t.type === 'number' || t.type === 'string' || t.type === 'bool') {
            this.next();
            return { kind: 'lit', value: t.value };
        }
        if (t.type === 'null') {
            this.next();
            return { kind: 'lit', value: null };
        }
        if (t.type === 'ident') {
            this.next();
            return { kind: 'ident', name: t.value };
        }
        if (this.isOp('(')) {
            this.next();
            const node = this.parseOr();
            this.expectOp(')');
            return node;
        }
        throw new Error('Unexpected token in expression');
    }
}

// ---------------------------------------------------------------------------
// 3. Evaluator (spec sections 4, 6, 7, 9, 10)
// ---------------------------------------------------------------------------

function evaluateNode(node, deps, values) {
    switch (node.kind) {
        case 'lit':
            return node.value;

        case 'ident': {
            // Spec 3.1 / 9: identifiers must appear in dependencies, and the
            // referenced variable must exist with a non-null/undefined value.
            if (!deps.includes(node.name)) {
                throw new Error(`Identifier "${node.name}" is not in this variable's dependencies`);
            }
            if (!Object.prototype.hasOwnProperty.call(values, node.name)) {
                throw new Error(`Variable "${node.name}" does not exist`);
            }
            const v = values[node.name];
            if (v === null || v === undefined) {
                throw new Error(`Variable "${node.name}" is null or undefined`);
            }
            return v;
        }

        case 'neg': {
            const v = evaluateNode(node.operand, deps, values);
            if (typeof v !== 'number') throw new Error('Unary "-" requires a numeric operand');
            return -v;
        }

        case 'not': {
            const v = evaluateNode(node.operand, deps, values);
            if (typeof v !== 'boolean') throw new Error('Unary "!" requires a boolean operand');
            return !v;
        }

        case 'ternary': {
            const cond = evaluateNode(node.condition, deps, values);
            if (typeof cond !== 'boolean') throw new Error('Ternary "?" condition must be boolean');
            // Only the selected branch is evaluated - the other is never
            // touched (JS's own ?: short-circuits the same way here).
            return cond ? evaluateNode(node.thenExpr, deps, values) : evaluateNode(node.elseExpr, deps, values);
        }

        case 'arith': {
            const l = evaluateNode(node.left, deps, values);
            const r = evaluateNode(node.right, deps, values);
            if (typeof l !== 'number' || typeof r !== 'number') {
                throw new Error(`Operator "${node.op}" requires numeric operands`);
            }
            switch (node.op) {
                case '+': return l + r;
                case '-': return l - r;
                case '*': return l * r;
                case '/':
                    if (r === 0) throw new Error('Division by zero');
                    return l / r;
                case '%':
                    if (r === 0) throw new Error('Division by zero');
                    return l % r;
                default:
                    throw new Error(`Unknown arithmetic operator "${node.op}"`);
            }
        }

        case 'compare': {
            const l = evaluateNode(node.left, deps, values);
            const r = evaluateNode(node.right, deps, values);

            if (node.op === '==' || node.op === '!=') {
                if (typeof l !== typeof r) {
                    throw new Error('"==" and "!=" require operands of the same type');
                }
                return node.op === '==' ? l === r : l !== r;
            }

            const bothNumbers = typeof l === 'number' && typeof r === 'number';
            const bothStrings = typeof l === 'string' && typeof r === 'string';
            if (!bothNumbers && !bothStrings) {
                throw new Error(`Operator "${node.op}" requires two numbers or two strings`);
            }
            switch (node.op) {
                case '<': return l < r;
                case '<=': return l <= r;
                case '>': return l > r;
                case '>=': return l >= r;
                default:
                    throw new Error(`Unknown comparison operator "${node.op}"`);
            }
        }

        case 'logical': {
            const l = evaluateNode(node.left, deps, values);
            if (typeof l !== 'boolean') throw new Error(`Operator "${node.op}" requires boolean operands`);
            if (node.op === '&&' && l === false) return false;
            if (node.op === '||' && l === true) return true;
            const r = evaluateNode(node.right, deps, values);
            if (typeof r !== 'boolean') throw new Error(`Operator "${node.op}" requires boolean operands`);
            return node.op === '&&' ? (l && r) : (l || r);
        }

        case 'prop': {
            const target = evaluateNode(node.target, deps, values);
            if (node.prop === 'length') {
                if (Array.isArray(target) || typeof target === 'string') return target.length;
                throw new Error('".length" requires an array or string');
            }
            throw new Error(`Unknown property ".${node.prop}"`);
        }

        case 'call': {
            const target = evaluateNode(node.target, deps, values);

            if (node.method === 'contains') {
                if (!Array.isArray(target)) throw new Error('".contains()" requires an array');
                if (node.args.length !== 1 || node.args[0].kind !== 'lit') {
                    throw new Error('".contains()" requires a single literal argument');
                }
                const arg = evaluateNode(node.args[0], deps, values);
                return target.includes(arg);
            }
            if (node.method === 'lower') {
                if (typeof target !== 'string') throw new Error('".lower()" requires a string');
                return target.toLowerCase();
            }
            if (node.method === 'upper') {
                if (typeof target !== 'string') throw new Error('".upper()" requires a string');
                return target.toUpperCase();
            }
            if (node.method === 'trim') {
                if (typeof target !== 'string') throw new Error('".trim()" requires a string');
                return target.trim();
            }
            throw new Error(`Unknown method ".${node.method}()"`);
        }

        default:
            throw new Error('Unknown expression node');
    }
}

// ---------------------------------------------------------------------------
// 4. Public entry point
// ---------------------------------------------------------------------------

// Evaluates `expression` against `values` (a { [depName]: currentValue } map
// - typically built by calculated-engine.js from each dependency's stored
// value). `dependencies` is the calculated variable's own declared
// dependencies array; identifiers outside it are rejected per spec 3.1.
// Always returns { ok: true, value } or { ok: false, error } - never throws.
export function evaluateExpression(expression, dependencies, values) {
    try {
        const expr = String(expression || '').trim();
        if (!expr) return { ok: false, error: 'Expression is empty' };

        const deps = Array.isArray(dependencies) ? dependencies : [];
        const tokens = tokenize(expr);
        const ast = new Parser(tokens).parse();
        const value = evaluateNode(ast, deps, values || {});

        if (typeof value === 'number' && !Number.isFinite(value)) {
            return { ok: false, error: 'Result is not a finite number' };
        }

        return { ok: true, value };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}
