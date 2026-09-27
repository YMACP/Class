# Third-party component notices

The Windows and Linux executables embed Bun 1.4.2. `Bun-LICENSE.txt` is the official
LICENSE.md from tag `bun-v1.4.2`, commit
`744846f844374847c902b5e7fd59b4342a51ef99`, including its dependency notices
and links. Source:
https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/LICENSE.md

Class uses unpdf 1.8.1 (MIT) and its bundled Mozilla PDF.js implementation
(Apache License 2.0) for PDF text extraction. These components are included
in the executables and are not modified by Class.

- unpdf: https://github.com/unjs/unpdf — see `unpdf-MIT.txt`.
- PDF.js: https://github.com/mozilla/pdf.js — see `PDFjs-Apache-2.0.txt`.

The Windows build writes these notices beside `Class.exe`, by default at
`../class-releases/windows-<architecture>/THIRD_PARTY_NOTICES.txt` outside the source tree
(`x64` or `arm64`).
Keep that file with the Windows distribution.

The Linux build writes the same notices to
`../class-releases/linux-<architecture>/THIRD_PARTY_NOTICES.txt`
(`amd64` or `arm64`). Keep that file with the Linux distribution too.
