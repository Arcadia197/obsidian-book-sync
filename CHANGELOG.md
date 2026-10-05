

## 0.1.0 (2026-10-05)


### Features

* add a single Goodreads book to Want to Read from the Book Sync tab ([80ec888](https://github.com/Arcadia197/obsidian-book-sync/commit/80ec8885ddd8f18eb1afe01f0fed1a24667a9622))
* change and vault interfaces for the pipeline steps ([0fc4d24](https://github.com/Arcadia197/obsidian-book-sync/commit/0fc4d244ee11b6d91e4d1736b4ee55a0ed647f6b))
* changes carry what the review window needs (vocabulary, dependency, note link) ([05814b9](https://github.com/Arcadia197/obsidian-book-sync/commit/05814b9f063121f8dcafb7afa8257ef824716b4e))
* clients for the Hardcover, Goodreads and OpenAI APIs ([2809115](https://github.com/Arcadia197/obsidian-book-sync/commit/28091150545aa512df00680494b34922601ce131))
* core parsers for the backlog table, lists mapping and book notes ([f4fb669](https://github.com/Arcadia197/obsidian-book-sync/commit/f4fb66965300843039fc5b543df736816d36fcc8))
* finished step fills dateRead, rating and review from Hardcover ([637abb2](https://github.com/Arcadia197/obsidian-book-sync/commit/637abb29f8652e9d876bcce0eb0c9dcd09a3fb3c))
* left for you list keeps hand work across runs and devices ([c6d1574](https://github.com/Arcadia197/obsidian-book-sync/commit/c6d15745ac50b5625b47d8ff7900fc2f4cc2dfb3))
* link backlog rows to Hardcover by isbn, with a paste field for the rest ([881e4d2](https://github.com/Arcadia197/obsidian-book-sync/commit/881e4d2a6dbd642e7ffe29311d541ab7cbca3b68))
* promote and reconcile steps for Database notes ([03d4ad2](https://github.com/Arcadia197/obsidian-book-sync/commit/03d4ad2e61f4deebe2950a1b61f00b5a63a2e657))
* pull the Goodreads shelf into the backlog as a reviewable plan ([2c17085](https://github.com/Arcadia197/obsidian-book-sync/commit/2c17085d902e36fd72bca2f00a95695070c2c235))
* push and labels steps write to Hardcover after review ([067bc6c](https://github.com/Arcadia197/obsidian-book-sync/commit/067bc6cf2293c4b9783507b871e22f8ed697a724))
* review tab walks through a sync step by step before anything is written ([a491c83](https://github.com/Arcadia197/obsidian-book-sync/commit/a491c83cec268667d16a6114781e9aad8dc4a55f))
* run any local step's plan and apply from the plugin ([f28dc5f](https://github.com/Arcadia197/obsidian-book-sync/commit/f28dc5f137299b423f80f290f958b121268a78a5))
* scaffold plugin with settings tab and secret storage ([8477185](https://github.com/Arcadia197/obsidian-book-sync/commit/84771858661199abcfba8510b7cd7c1a65a409ff))
* settings get folder and file suggestions, a model dropdown and key tests ([3c97d9a](https://github.com/Arcadia197/obsidian-book-sync/commit/3c97d9a245e3a5f30782c17bc1d100292b108400))
* sync session runs steps one at a time for the review window ([0f8d6c8](https://github.com/Arcadia197/obsidian-book-sync/commit/0f8d6c8215c2cb77e5294b490dc0e70b3dd32ae2))


### Bug Fixes

* a push into a new list says that ticking it ticks the list too ([d3a7d0d](https://github.com/Arcadia197/obsidian-book-sync/commit/d3a7d0d64500dd78e46b35f15e551bedb126a007))
* each new step of a sync starts at the top of the tab ([fc1ecd7](https://github.com/Arcadia197/obsidian-book-sync/commit/fc1ecd7ae8f4e3076f479fc28eec3f0ed680521e))
* keep API keys in data.json instead of Obsidian's secret storage ([1a3eb95](https://github.com/Arcadia197/obsidian-book-sync/commit/1a3eb9507c2c5bc0f3340c28f364d2514ed35505))
* left for you items clear only when really done and survive edits on two devices ([f2adedf](https://github.com/Arcadia197/obsidian-book-sync/commit/f2adedf6f7cabecd3cc52af1f04c051f4b374cc4))
* never pick a row by order when two rows share a goodreads_id ([3cc691f](https://github.com/Arcadia197/obsidian-book-sync/commit/3cc691f1d54871ef8001ef0568702a9bf1c41a02))
* review tab stays clear of the status bar and the phone's floating bars ([6917a7a](https://github.com/Arcadia197/obsidian-book-sync/commit/6917a7a24c8b45cb530541acf0abda8c8c3db8be))
* stale link lookups, refine and end-while-writing races, left-for-you edge cases ([d096d44](https://github.com/Arcadia197/obsidian-book-sync/commit/d096d4451ea06cebc31442c095d6cde9662f66b6))
* status bar shows what's left for you even without the Book Sync tab open ([b1e2893](https://github.com/Arcadia197/obsidian-book-sync/commit/b1e289318a5d82789e77dcf4917ebc839396e62a))
* the edition item after a push waits for an edition you picked ([7a06565](https://github.com/Arcadia197/obsidian-book-sync/commit/7a06565c5035c678f401e395d38f3bf432da1831))
* the Goodreads RSS URL may be the base, the plugin picks the shelf ([2dd3ed9](https://github.com/Arcadia197/obsidian-book-sync/commit/2dd3ed9423d1ef0882701eeccbb3ee9ca57d6d9c))