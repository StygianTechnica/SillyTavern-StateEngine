# State Engine Expression DSL Specification  
Version 1.2 — Tiny Expression DSL for Computed Variables (adds rand(), section 8 - the DSL's first built-in function, and its documented exception to the Deterministic design goal)

This document defines the deterministic, side‑effect‑free expression language used by calculated variables in the State Engine. The DSL is intentionally small, predictable, and easy to evaluate without LLM involvement.

---

## 1. Design Goals

- Deterministic: Same inputs always produce the same output, with one
  narrow, explicit exception - the `rand()` built-in (section 8) - which
  exists precisely to be non-deterministic (dice rolls, random encounter
  tables) and is documented as such rather than silently violating this
  goal.
- Pure: Expressions cannot mutate state or perform I/O.
- Safe: No arbitrary code execution.
- Minimal: Only essential operators and functions.
- Readable: Easy for preset authors to understand and debug.
- Composable: Can reference other State Engine variables.

---

## 2. Grammar Overview

Expressions are single‑line infix expressions composed of:

- variable references
- literals
- operators
- parentheses
- optional string/array property access

Whitespace is ignored except inside string literals.

---

## 3. Lexical Elements

### 3.1 Identifiers

Identifiers reference other variables.

Pattern:
[A-Za-z_][A-Za-z0-9_]*

Identifiers are case‑sensitive.  
Identifiers must appear in the variable’s dependencies list.

---

### 3.2 Literals

#### Numbers
- Integers or floats
- Must parse to a finite number

Examples:
42  
3.14  
-5  
0

#### Strings
- Single or double quotes
- No escape sequences beyond \" and \\

Examples:
"hello"  
"world"

#### Booleans
true  
false

#### Null
null

---

## 4. Operators

### 4.1 Arithmetic

+   addition  
-   subtraction  
*   multiplication  
/   division  
%   remainder

Operands must be numeric.  
Division by zero causes evaluation failure.

---

### 4.2 Comparison

==   equal  
!=   not equal  
<    less than  
<=   less than or equal  
>    greater than  
>=   greater than or equal

Operands must be compatible types:
- number vs number
- string vs string
- boolean vs boolean

Comparisons between incompatible types cause evaluation failure.

---

### 4.3 Logical

&&   logical AND  
||   logical OR  
!    logical NOT

Operands must be boolean.

---

### 4.4 Unary

-x   numeric negation  
!x   boolean negation

---

### 4.5 Conditional (Ternary) Operator

```
condition ? exprIfTrue : exprIfFalse
```

- `condition` must evaluate to a boolean; evaluation fails otherwise (section 11.3).
- Only the selected branch is evaluated - the other is never touched.
- Both branches must be valid expressions (parsing does not depend on which one runs).
- The result is whatever value the selected branch returns - its type is not constrained by the DSL.
- Follows standard precedence rules (see section 5): its own tier, between Equality and Logical AND.
- Not right-associative / self-nesting: each of `condition`, `exprIfTrue`, and `exprIfFalse` is itself
  one Equality-level expression (arithmetic/comparison/equality, no bare `&&`, `||`, or another `? :`).
  A nested ternary in a branch position needs explicit parentheses: `a ? b : (c ? d : e)` works;
  `a ? b : c ? d : e` does not.

Example:

```
status = isOpen ? "Open" : "Closed"
```

---

## 5. Precedence and Associativity

From highest to lowest:

1. Parentheses
2. Unary (!x, -x)
3. Multiplicative (*, /, %)
4. Additive (+, -)
5. Comparison (<, <=, >, >=)
6. Equality (==, !=)
7. Ternary (? :)
8. Logical AND (&&)
9. Logical OR (||)

All binary operators are left‑associative. The ternary operator is not
right-associative (see 4.5) - each of its three parts is exactly one
Equality-level expression.

---

## 6. Array Operations

Array operations use dot notation.

### 6.1 Length

myArray.length  
Returns a number.

### 6.2 Contains

myArray.contains("value")  
myArray.contains(42)

Rules:
- Operand must be a literal.
- Uses strict equality (===).
- Returns boolean.

### 6.3 Type Requirements

The referenced variable must be of type array.  
Otherwise evaluation fails.

---

## 7. String Operations

String operations use dot notation.

### 7.1 Lowercase
myString.lower()

### 7.2 Uppercase
myString.upper()

### 7.3 Trim
myString.trim()

### 7.4 Length
myString.length

### 7.5 Type Requirements

The referenced variable must be of type string.  
Otherwise evaluation fails.

---

## 8. Built-in Functions

Unlike array/string operations (sections 6-7), which are dot-notation
methods on a value (`myArray.contains(...)`, `myString.lower()`), a
built-in function is called bare - `name(args)` - with no receiver and no
`.` before it. `name.rand(args)` and `random.rand(20)` are never valid:
`rand` is not registered as a dot-method, so those parse as (or fail as) a
property/method access on whatever `name`/`random` resolves to, never as a
call to this function.

### 8.1 rand(n) / rand(n, trigger)

Returns a random integer in the inclusive range `1..n`.

Arguments:
- `n` (required): a positive integer literal or a variable resolving to a
  positive, finite integer. Not an integer, not finite, not positive, or
  not a number at all → evaluation fails.
- `trigger` (optional): a boolean literal or a variable resolving to a
  boolean. Its *value* is never read beyond confirming it is boolean - its
  only purpose is to appear in this variable's `dependencies`, so that a
  dependency-change re-evaluation (section 10) re-rolls. Present but not
  boolean → evaluation fails.
- Any other argument count (0, or more than 2) → evaluation fails.

Examples:

```
rand(20)                          // d20, no dependencies
rand(diceSize)                    // die size from another variable
rand(diceSize, rollTrigger)       // re-rolls when rollTrigger changes
rand(20, (roundNumber % 2 == 0))  // re-rolls every other round
```

`rand()` is the DSL's sole deliberate exception to section 1's
"Deterministic" goal and section 11.1 below - see both for what that means
and why it's still safe (pure in every other sense: no state, no I/O, no
external calls beyond `Math.random()`'s own entropy source).

Because a fresh call always produces a new value, evaluating a `rand()`
expression twice with identical arguments will *not* produce the same
result - the "same inputs -> same output" guarantee this DSL otherwise
makes for every other operator/function does not apply here. A calculated
variable using `rand()` re-rolls whenever the containing expression is
re-evaluated for any reason (section 10) - including a `recalculateAllForChat`
sweep unrelated to this variable's own dependencies, not only when `n` or
`trigger` actually change; there is no per-variable "did my inputs really
change" gate in the current recalculation model.

Every identifier referenced inside `rand(...)` - `n` and `trigger` alike -
must still appear in the variable's `dependencies` array (section 10), the
same as any other identifier used anywhere in the expression.

---

## 9. Parentheses

Parentheses may be used to override precedence:

(strength + dexterity) * 2

---

## 10. Variable Resolution

Each identifier must refer to a variable listed in dependencies.

Resolution rules:

- If the variable does not exist → evaluation fails.
- If the variable’s value is null or undefined → evaluation fails.
- If the variable’s type does not match the operation → evaluation fails.

No implicit coercion is performed.

---

## 11. Evaluation Model

### 11.1 Deterministic
Evaluation must produce the same result for the same inputs, with the sole
exception of `rand()` (section 8.1), which is deterministic in every sense
except the one thing it exists to *not* be (its return value) - it still
takes no side effects, touches no state, and depends on nothing beyond its
own arguments and JavaScript's built-in entropy source.

### 11.2 Pure
Expressions cannot:
- mutate variables
- call external functions
- access global state
- perform I/O
- reference chat messages
- reference the LLM

`rand()`'s use of `Math.random()` is not considered a violation of this
rule - it reads no State Engine variable, chat data, or extension state,
and writes nothing itself (evaluateExpression() always returns a plain
value; only its caller, evaluateCalculatedVariable(), ever writes anything,
through the same setVar() path any other calculated result uses).

### 11.3 Error Handling
If evaluation fails:
- the calculated variable retains its previous stored value
- no exception is thrown
- no partial update occurs

---

## 12. Examples

### 12.1 Numeric
strength + dexterity * 2

### 12.2 Boolean
is_indoor && (weather == "storm")

### 12.3 String
current_location.lower()

### 12.4 Array
encounter_tags.contains("boss") && threat_level == "high"

### 12.5 Mixed
npc_trust > 50 && quest_active

### 12.6 Random
rand(20, rollTrigger)

---

## 13. Serialization

Expressions are stored as plain strings in the variable definition:

{
  "name": "danger_score",
  "type": "calculated",
  "dependencies": ["base_danger", "npc_trust"],
  "expression": "base_danger + npc_trust / 2"
}

Rules:
- expression is a single-line UTF‑8 string.
- No multi-statement programs.
- No embedded JSON.
- The DSL itself is the only language.

---

## 14. Reserved Words

The following identifiers are reserved and must not be used as variable names:

true  
false  
null  
rand (built-in function, section 8.1)  
Any other built-in function names  
Any future reserved keywords added to this DSL
