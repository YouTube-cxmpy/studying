// A small, safe parser for the functions the model asks us to plot, such as
// "x^2 + 4x + 1", "2(x-3)^2 - 5", "sqrt(x+4)", "sin(2x)" or "|x - 1|".
// It never uses eval: text is tokenized and compiled to a plain JS closure.

type Fn = (x: number) => number;

const FUNCS: Record<string, (v: number) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const s = src
    .replace(/\s+/g, "")
    .replace(/[−–]/g, "-")
    .replace(/[·×]/g, "*")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/π/g, "pi")
    .replace(/\*\*/g, "^")
    .replace(/\\cdot/g, "*")
    .replace(/\\left|\\right/g, "")
    .replace(/\\sqrt\{([^}]*)\}/g, "sqrt($1)")
    .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "(($1)/($2))")
    .replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"))
    .replace(/\\/g, "");
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+(?:e[+-]?\d+)?|^\d+\.?/i.exec(s.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(s.slice(i))![0].toLowerCase();
      // Split runs like "xsin" or "2pix" into known names and single letters.
      let j = 0;
      while (j < m.length) {
        const name = Object.keys(FUNCS)
          .concat(Object.keys(CONSTS))
          .sort((a, b) => b.length - a.length)
          .find((n) => m.startsWith(n, j));
        if (name) {
          out.push({ t: "id", v: name });
          j += name.length;
        } else {
          out.push({ t: "id", v: m[j] });
          j += 1;
        }
      }
      i += m.length;
    } else if ("+-*/^()|,".includes(c)) {
      out.push({ t: "op", v: c });
      i += 1;
    } else {
      throw new Error(`Unexpected "${c}"`);
    }
  }
  return out;
}

/** Turns an expression in x into a function, or throws if it can't be read. */
export function compile(src: string): Fn {
  const tokens = tokenize(src.replace(/^\s*(?:y|f\s*\(\s*x\s*\))\s*=\s*/i, ""));
  let pos = 0;
  let absDepth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };

  // Can the next token start a factor that multiplies implicitly ("2x", "3(x+1)", "x sin(x)")?
  const startsFactor = () => {
    const t = peek();
    if (!t) return false;
    if (t.t === "num" || t.t === "id") return true;
    if (t.t === "op" && t.v === "(") return true;
    // "|" opens an absolute value only when we're not inside one waiting to close.
    return t.t === "op" && t.v === "|" && absDepth === 0;
  };

  function expr(): Fn {
    let left = term();
    while (isOp("+") || isOp("-")) {
      const op = tokens[pos++].v;
      const a = left;
      const b = term();
      left = op === "+" ? (x) => a(x) + b(x) : (x) => a(x) - b(x);
    }
    return left;
  }
  function term(): Fn {
    let left = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = tokens[pos++].v;
        const a = left;
        const b = unary();
        left = op === "*" ? (x) => a(x) * b(x) : (x) => a(x) / b(x);
      } else if (startsFactor()) {
        const a = left;
        const b = power();
        left = (x) => a(x) * b(x);
      } else return left;
    }
  }
  function unary(): Fn {
    if (isOp("-")) {
      pos++;
      const a = unary();
      return (x) => -a(x);
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  }
  function power(): Fn {
    const base = atom();
    if (isOp("^")) {
      pos++;
      const exp = unary(); // right-associative, allows x^-1
      return (x) => {
        const b = base(x);
        const e = exp(x);
        // Odd roots of negatives, e.g. x^(1/3), stay real.
        if (b < 0 && !Number.isInteger(e)) {
          const inv = 1 / e;
          if (Number.isInteger(Math.round(inv)) && Math.abs(inv - Math.round(inv)) < 1e-9 && Math.round(inv) % 2 !== 0) {
            return -Math.pow(-b, e);
          }
        }
        return Math.pow(b, e);
      };
    }
    return base;
  }
  function atom(): Fn {
    const t = tokens[pos++];
    if (!t) throw new Error("Unexpected end");
    if (t.t === "num") return () => t.v;
    if (t.t === "id") {
      if (t.v === "x") return (x) => x;
      if (t.v in CONSTS) return () => CONSTS[t.v];
      if (t.v in FUNCS) {
        const f = FUNCS[t.v];
        // Allow "sin x" as well as "sin(x)".
        const arg = isOp("(") ? atom() : power();
        return (x) => f(arg(x));
      }
      throw new Error(`Unknown name "${t.v}"`);
    }
    if (t.v === "(") {
      const inner = expr();
      expect(")");
      return inner;
    }
    if (t.v === "|") {
      absDepth++;
      const inner = expr();
      absDepth--;
      expect("|");
      return (x) => Math.abs(inner(x));
    }
    throw new Error(`Unexpected "${t.v}"`);
  }

  const fn = expr();
  if (pos !== tokens.length) throw new Error("Couldn't read the whole expression");
  return fn;
}
