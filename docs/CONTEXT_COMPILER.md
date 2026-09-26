# ContextForge — Context Compiler Subsystem Specification

> **Core Purpose**: Compile the smallest, densest, highest-relevance source context for external coding AIs (ChatGPT, Claude, DeepSeek) so they can generate valid surgical patches without token waste or hallucinations.

---

## 1. The Context Compiler Pipeline

```text
[ USER ISSUE DESCRIPTION ] + [ RUNTIME ERROR & STACK ]
                        ↓
            [ RELEVANCE SCORING ENGINE ]
            - Error location (100%)
            - Stack trace chain (95%)
            - Keyword match (80%)
            - Static dependency graph (75%)
                        ↓
            [ AUTOMATIC FILE SELECTION ]
            - Ranked candidate list with explanations
            - Top files auto-attached; others optional
                        ↓
            [ VERBATIM CODE SLICING ]
            - Slice A: Crime scene (failing function body from disk)
            - Slice B: Callers (5-10 lines in caller routine)
            - Slice C: Callees (exact signatures of called helpers)
            - Slice D: Mutated state (class constructor variable decls)
                        ↓
            [ TOKEN BUDGET & CONFIDENCE METER ]
            - Micro (~500 tokens)
            - Balanced (~1,500 tokens) [DEFAULT]
            - Deep (~3,000 tokens)
            - Auto-expansion guard if context crosses module boundaries
                        ↓
            [ STRICT COMPILED AI PROMPT ]
            - Strict "DO NOT INVENT FIND" contract
            - Character-for-character verbatim original text
```

---

## 2. Code Slicing vs. Signature Stubs

### The Failure of Stubs
Sending:
```text
class Player {
  updateMovement()
}
```
forces the AI to guess the internal lines of `updateMovement()`. When it emits `<<<<<<< FIND`, the patch fails because the code on disk is different.

### The Slice Contract
ContextForge extracts the **exact lines from disk**:
```text
### FILE: src/player.js
### FUNCTION: updateMovement() (Lines 140-185 verbatim from disk)
updateMovement(delta) {
  if (!this.isGrounded) {
    this.velocity.y += GRAVITY * delta;
  }
  this.mesh.position.addScaledVector(this.velocity, delta);
}
```
The external AI now has the exact character sequence to copy into its `<<<<<<< FIND` block.

---

## 3. Strict Patch Instruction Embedded in Prompts

Every generated prompt includes:
```text
STRICT SURGICAL PATCH CONTRACT:
1. Every FIND section must be an EXACT, character-for-character substring of the supplied source code.
2. Do NOT normalize whitespace or re-indent.
3. Do NOT paraphrase or omit lines.
4. Do NOT guess original code that was not provided in the context.
If the supplied context is insufficient, respond with "CONTEXT INSUFFICIENT" and name the required file/symbol.
```
