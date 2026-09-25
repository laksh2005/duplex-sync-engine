/**
 * Parity - Google Sheets push trigger
 *
 * Notifies the sync server the moment someone edits the sheet, so a sync runs
 * on the edit instead of waiting for a poll.
 *
 * Setup
 * -----
 * 1. In the Google Sheet: Extensions > Apps Script, and paste this file in.
 * 2. Project Settings > Script Properties, add:
 *      SYNC_WEBHOOK_URL   https://your-server/api/webhook/sheet
 *      SYNC_WEBHOOK_SECRET  (must match WEBHOOK_SECRET on the server)
 *      SYNC_TIMEZONE      your local zone, e.g. Asia/Kolkata
 * 3. Run installTrigger() once and grant the permissions it asks for.
 *
 * It has to be an INSTALLABLE trigger, not a simple onEdit(e) function: simple
 * triggers run without authorization and are not allowed to call UrlFetchApp.
 * installTrigger() creates the installable one for you.
 */

var THROTTLE_SECONDS = 2;

function installTrigger() {
  var sheet = SpreadsheetApp.getActive();

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(sheet).onEdit().create();

  Logger.log('Installed onEdit trigger for: ' + sheet.getName());
}

function onSheetEdit(e) {
  bumpUpdatedAt(e);

  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SYNC_WEBHOOK_URL');
  var secret = props.getProperty('SYNC_WEBHOOK_SECRET');

  if (!url || !secret) {
    Logger.log('SYNC_WEBHOOK_URL or SYNC_WEBHOOK_SECRET not set; skipping');
    return;
  }

  // A paste or fill-down fires this handler once per edited range. The server
  // dedupes anyway, but throttling here keeps us well inside the Apps Script
  // UrlFetch daily quota.
  var cache = CacheService.getScriptCache();
  if (cache.get('sync_sent')) {
    return;
  }
  cache.put('sync_sent', '1', THROTTLE_SECONDS);

  var payload = {
    changedAt: Date.now(),
    range: e && e.range ? e.range.getA1Notation() : null,
    sheet: e && e.range ? e.range.getSheet().getName() : null
  };

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-webhook-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code >= 300) {
      Logger.log('Sync webhook returned ' + code + ': ' + response.getContentText());
    }
  } catch (err) {
    // Never let a webhook failure surface as an error in the user's sheet.
    Logger.log('Sync webhook failed: ' + err);
  }
}

/**
 * Keeps updated_at honest. Editing a row's data does not touch its
 * updated_at cell on its own, so without this a row's timestamp can go stale
 * while its content changes. That matters because the sync engine breaks a
 * tie between two identical timestamps in the database's favor, so a stale
 * timestamp lets an old database value silently overwrite a fresh sheet edit.
 *
 * Writing to the updated_at cell fires onEdit again; the column check below
 * stops that from recursing.
 */
function bumpUpdatedAt(e) {
  if (!e || !e.range) {
    return;
  }

  var sheet = e.range.getSheet();
  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();
  if (startRow < 2 && startRow + numRows - 1 < 2) {
    return; // header-only edit
  }

  var lastColumn = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var updatedAtCol = -1;
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === 'updated_at') {
      updatedAtCol = i + 1;
      break;
    }
  }
  if (updatedAtCol === -1) {
    return;
  }

  var editedStartCol = e.range.getColumn();
  var editedEndCol = editedStartCol + e.range.getNumColumns() - 1;
  if (editedStartCol === updatedAtCol && editedEndCol === updatedAtCol) {
    return; // this is the recursive call from our own write below
  }

  // Written as plain text in the same readable form the server uses, e.g.
  // "4:39:12 PM, 9 Sep 2026", not as a Date: a Date renders in the viewer's
  // locale (dd/mm vs mm/dd), which the server cannot parse reliably. The zone
  // must match the server's local time, so SYNC_TIMEZONE pins it (for India,
  // Asia/Kolkata); without it the spreadsheet's own timezone is used.
  var zone =
    PropertiesService.getScriptProperties().getProperty('SYNC_TIMEZONE') ||
    SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  var now = Utilities.formatDate(new Date(), zone, 'h:mm:ss a, d MMM yyyy');
  var firstDataRow = Math.max(startRow, 2);
  var lastRow = startRow + numRows - 1;
  for (var row = firstDataRow; row <= lastRow; row++) {
    sheet.getRange(row, updatedAtCol).setNumberFormat('@').setValue(now);
  }
}

/** Fires one test request so you can confirm the wiring without editing a cell. */
function testWebhook() {
  onSheetEdit(null);
  Logger.log('Test webhook sent');
}
