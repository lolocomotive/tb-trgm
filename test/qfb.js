// Select Inbox, type a query into the Quick Filter, return visible subjects in order.
const query = arguments[0];
const tabmail = window.document.getElementById("tabmail");
const about3Pane = tabmail.currentAbout3Pane;
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const inbox = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed("Inbox");
if (about3Pane.gFolder?.URI !== inbox.URI) {
  about3Pane.displayFolder(inbox.URI);
  await new Promise(r => setTimeout(r, 1500));
}
const qfb = about3Pane.quickFilterBar;
if (!qfb.filterer.visible) { qfb._showFilterBar(true); }
const box = about3Pane.document.getElementById("qfb-qs-textbox");
box.value = query;
box.dispatchEvent(new about3Pane.CustomEvent("autocomplete", { detail: query }));
// fall back: directly set state
qfb.filterer.setFilterValue("text", { text: query, states: qfb.filterer.filterValues.text?.states || { sender: true, recipients: true, subject: true, body: true } });
qfb.updateSearch();
await new Promise(r => setTimeout(r, 2500));
const view = about3Pane.gDBView;
const rows = [];
for (let i = 0; i < Math.min(view.rowCount, 12); i++) {
  const h = view.getMsgHdrAt(i);
  rows.push(h.mime2DecodedSubject + " | " + h.mime2DecodedAuthor + " | rel=" + view.cellTextForColumn(i, "trigramRelevanceCol"));
}
return { count: view.rowCount, states: qfb.filterer.filterValues.text.states, sort: about3Pane.gViewWrapper._sort, rows };
