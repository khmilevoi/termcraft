# A real `format_version = 1` project, preserved verbatim

This is the portable part of `examples/clock/.termcraft/` exactly as it stood before the
multi-file design tree landed: a `project.toml` at `format_version = 1` carrying its own
ordered `pages` array, and the `pages/<slug>/page.tsx` layout that array names. It is copied
byte for byte and is plan 1b's migration test subject — the one thing the real migration will
be run against and measured on. Nothing in the shipped product reads this layout: design §12.1
is explicit that "no compatibility reader for it exists anywhere in the system", so opening a
project in this shape fails today by design rather than by omission. **Do not "fix" it to
version 2, do not renumber it, and do not reformat it** — its value is entirely in being an
unretouched specimen of what a real user's project looked like before the change.
