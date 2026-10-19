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
`../class-releases/windows-x64/THIRD_PARTY_NOTICES.txt` outside the source tree.
Keep that file with the Windows distribution.

The Linux build writes the same notices to
`../class-releases/linux-amd64/THIRD_PARTY_NOTICES.txt`.
Keep that file with the Linux distribution too.

## Bundled Skill resources

Class includes selected, pinned Skill directories from the following community
projects. Exact commits, source paths and file lists are recorded in
`assets/builtin-skills/manifest.json`. Original resources are retained; Class adds
its own loading, member authorization and workflow guidance around them. Helpers
are reference material and are never automatically executed or installed.

- ctf-skills: https://github.com/ljagiello/ctf-skills
  Copyright (c) 2026 Lukasz Jagiello. MIT License, reproduced below.
- Anthropic-Cybersecurity-Skills:
  https://github.com/mukul975/Anthropic-Cybersecurity-Skills
  Copyright 2026 mukul975 and the contributors identified in the Skill files.
  Licensed under the Apache License, Version 2.0. The full terms already included
  in `PDFjs-Apache-2.0.txt` also apply to these Skill resources. This is an
  independent community project, not an Anthropic PBC product.

No separate upstream LICENSE file or `install_ctf_tools.sh` is bundled with the
Skill directories. The notices here are included in both executable distributions.
They are also embedded in each executable and served at
`/third-party-notices.txt` on the running Class local service.

MIT License (ctf-skills)

Copyright (c) 2026 Lukasz Jagiello

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
