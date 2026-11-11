# Development notes

## How it works

- **`src/engine/engine.sys.mjs`:** the search engine. It works the same inside Thunderbird and in Node.
  - Every field is normalized: lower-cased, diacritics stripped, punctuation collapsed to single spaces, then padded with a space on each side. It is stored in two contentless FTS5 tables:
    - `fts` uses the `trigram` tokenizer. Because the padding spaces are indexed too, one index answers substrings (`"oe"`), word prefixes (`" do"`) and whole words (`" doe "`).
    - `fwd` uses the word tokenizer, for fast whole-word, phrase and fuzzy lookups.
  - Fuzzy matching: every distinct word goes into `words`, which has its own trigram index (`wfts`). A query word expands to similar vocabulary words by trigram similarity, and those are looked up in `fwd`.
  - Message bodies are indexed but not stored.
- **`src/api/trigram/parent.js`:** the Experiment, running in Thunderbird's main process.
  - Opens `trigram-search.sqlite` in the profile through `Sqlite.sys.mjs`, with FTS5 loaded.
  - Reads headers straight from each folder's message database, and bodies straight from the local message store. MIME parsing skips attachment payloads.
  - Keeps the index current through `nsIMsgFolderListener`: new mail, deletes, moves (which keep their indexed content), copies, tag changes, folder renames, moves and deletes. A periodic rescan reconciles anything else.
  - Plugs into the Quick Filter with a custom search term, a patched `MessageTextFilter` and a wrapped `quickFilterBar.updateSearch`. The wrapper holds the list until results are ready.
  - For the full-screen page, it wraps `tabmail.openTab`: when Thunderbird opens `glodaFacet` / `glodaTableList` with a Gloda searcher, it passes a trigram searcher with the same interface instead. Its messages come from `Gloda.getMessageCollectionForHeaders`.
  - Everything is restored when the add-on is disabled.
- **`src/background/main.js`, `src/options/`:** forward options to the Experiment.

IMAP messages that aren't synchronized for offline use are indexed by headers only. Their bodies are picked up once Thunderbird downloads them.

## Performance

Measured in Thunderbird 159 on a local folder of 20,000 messages (~300-word bodies, 49 MB mbox):

- **Initial index:** 17 s for all 20k messages including bodies (~1,200 messages/s). The interface stayed responsive (14 ms average event-loop lag).
- **Restart:** the index is on disk and usable immediately. A background scan only picks up changes.
- **Quick Filter on that folder,** including Thunderbird rebuilding the list: about 0.2–0.4 s for typical queries, about 1 s for words found in nearly every message.
- **Index size:** about 4× the mail text (212 MB for the 49 MB mbox). Trigram indexes are big; that's the price of matching any substring.

## Development

```bash
npm test              # engine tests (node:sqlite, needs Node 22+)
test/run-tb.sh        # headless Thunderbird on test/profile, Marionette on :2829
python3 test/marionette.py < script.js   # run privileged JS in it
```

To build the test profile:
- Create a proxy file `test/profile/extensions/trigram-search@lolocomotive` containing the absolute path of `src/`.
- Copy `test/profile-user.js` to `test/profile/user.js`. It holds the Local Folders account and Marionette prefs.
- Put mbox files in `test/profile/Mail/Local Folders/`.

`test/qfb.js` drives the Quick Filter, and `test/dbstat.js` inspects the index.

## Limitations

- In threaded views, the relevance sort orders threads by their root message.
- The full-screen page shows at most `mailnews.database.global.search.msg.limit` results (1,000 by default), the same limit Gloda uses.
- Encrypted bodies are not indexed.
- Each body is capped at `maxBodyChars` (20,000 by default).

## Releasing

Versions follow [semver](https://semver.org). The version lives in `src/manifest.json` and is mirrored in `package.json`.

```bash
npm run release -- 1.1.0     # bump, test, build, commit "Release v1.1.0", tag v1.1.0
git push && git push origin v1.1.0
```

Pushing a `v*` tag runs `.github/workflows/release.yml`. It runs the tests, checks that the tag matches the manifest version, builds `tb-trgm-<version>.xpi` and publishes a GitHub release with it attached.
