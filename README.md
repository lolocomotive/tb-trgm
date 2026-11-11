# tb-trgm: trigram search for Thunderbird

Thunderbird's built-in search can't find text inside words and has no typo tolerance. This add-on gives the **Quick Filter bar** and the **global search** a real trigram index (SQLite FTS5), so you can:

- find text **inside words**: `uarterl` finds "Quarterly"; `invoice-44` finds `invoice-4471.pdf`
- tolerate **typos**: `recieve` finds "receive"
- ignore **accents and case**: `munchen` finds "München"
- search **every field**: from, to, cc, bcc, subject, body, attachment names and tags

Everything stays in Thunderbird's normal UI. Search with the Quick Filter as usual (its Sender / Recipients / Subject / Body buttons still choose the fields), or press Enter / use the global search box for the full-screen results page. Results are sorted by date by default; a **Relevance** column ranks exact matches above fuzzy ones if you prefer.

## Install

1. Download `tb-trgm-<version>.xpi` from the [latest release](https://github.com/lolocomotive/tb-trgm/releases/latest).
2. In Thunderbird, go to **Add-ons Manager → ⚙ → Install Add-on From File…** and pick the file.

The first index is built in the background, and progress shows in the status bar. As a rough guide, 20,000 messages take about 20 seconds. Settings and index status are in the add-on's **Options**.

Requires Thunderbird 128 or newer. The add-on is unsigned and uses an Experiment API, which Thunderbird release builds allow.

## Good to know

- The index is stored in your profile as `trigram-search.sqlite`, about 4× the size of the mail text.
- IMAP messages that aren't synchronized for offline use are searchable by their headers until Thunderbird downloads them.
- The full-screen results page relies on Thunderbird's own search indexing (Gloda), which is on by default.

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE)
