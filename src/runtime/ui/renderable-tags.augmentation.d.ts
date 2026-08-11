// The `declare module "@opentui/react"` augmentation for the four renderables that have no
// intrinsic JSX tag (spec §6.1). It is the vendor's own pattern — see
// `node_modules/@opentui/react/src/time-to-first-draw.d.ts`, which augments `OpenTUIComponents`
// exactly this way for its own extended tag.
//
// WHY IT EXISTS AT ALL. `OpenTUIComponents` carries a string index signature
// (`node_modules/@opentui/react/src/types/components.d.ts`), so an `extend()`-registered tag
// type-checks with `any` props whether or not registration ever happened. Without this file the
// four wrappers below would compile against nothing.
//
// WHY IT IS A SEPARATE `.d.ts` AND NOT A BLOCK INSIDE `renderable-tags.ts` (stated divergence
// from §6.1's "colocated", plan P5 D2). `scripts/gen-runtime-dts.ts` FLATTENS every emitted
// declaration in `src/runtime/index.ts`'s import graph into one `declare module
// "@termcraft/runtime" { … }` block. An augmentation emitted from a `.ts` file would land inside
// that block as a nested ambient module declaration (invalid), and would hoist
// `import { SliderRenderable, … } from "@opentui/core"` into the AGENT-FACING prompt copy —
// exactly the `@opentui` leak §6 exists to prevent. tsc emits no output for a `.d.ts` input, so
// this file is invisible to the generator while still applying program-wide under the repo
// tsconfig's `include: ["src"]`. Colocation is kept as far as it can be: same directory, paired
// basename with `renderable-tags.ts`.
import type {
  FrameBufferRenderable,
  ScrollBarRenderable,
  SliderRenderable,
  TextTableRenderable,
} from "@opentui/core";

declare module "@opentui/react" {
  interface OpenTUIComponents {
    slider: typeof SliderRenderable;
    "scroll-bar": typeof ScrollBarRenderable;
    "text-table": typeof TextTableRenderable;
    "frame-buffer": typeof FrameBufferRenderable;
  }
}
