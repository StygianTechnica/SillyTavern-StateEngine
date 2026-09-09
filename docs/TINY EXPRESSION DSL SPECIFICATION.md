# State Engine Expression DSL Specification  
Version 1.0 — Tiny Expression DSL for Computed Variables

This document defines the deterministic, side‑effect‑free expression language used by calculated variables in the State Engine. The DSL is intentionally small, predictable, and easy to evaluate without LLM involvement.

---

## 1. Design Goals

- Deterministic: Same inputs always produce the same output.
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

## 5. Precedence and Associativity

From highest to lowest:

1. Parentheses
2. Unary (!x, -x)
3. Multiplicative (*, /, %)
4. Additive (+, -)
5. Comparison (<, <=, >, >=)
6. Equality (==, !=)
7. Logical AND (&&)
8. Logical OR (||)

All binary operators are left‑associative.

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

## 8. Parentheses

Parentheses may be used to override precedence:

(strength + dexterity) * 2

---

## 9. Variable Resolution

Each identifier must refer to a variable listed in dependencies.

Resolution rules:

- If the variable does not exist → evaluation fails.
- If the variable’s value is null or undefined → evaluation fails.
- If the variable’s type does not match the operation → evaluation fails.

No implicit coercion is performed.

---

## 10. Evaluation Model

### 10.1 Deterministic
Evaluation must produce the same result for the same inputs.

### 10.2 Pure
Expressions cannot:
- mutate variables
- call external functions
- access global state
- perform I/O
- reference chat messages
- reference the LLM

### 10.3 Error Handling
If evaluation fails:
- the calculated variable retains its previous stored value
- no exception is thrown
- no partial update occurs

---

## 11. Examples

### 11.1 Numeric
strength + dexterity * 2

### 11.2 Boolean
is_indoor && (weather == "storm")

### 11.3 String
current_location.lower()

### 11.4 Array
encounter_tags.contains("boss") && threat_level == "high"

### 11.5 Mixed
npc_trust > 50 && quest_active

---

## 12. Serialization

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

## 13. Reserved Words

The following identifiers are reserved and must not be used as variable names:

true  
false  
null  
Any built-in function names  
Any future reserved keywords added to this DSL
