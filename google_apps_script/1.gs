function auto_share_for_connected_ai_studio() {
  var force_full_check = 0;
  var stop_at_error = 0;
  var alert_at_error = 1;
  var mail_daily_report = 1;
  var mail_monthly_report = 1;
  var mail_target = 0;
  var share_notification_silencer = 0;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;

  try {
    var p = PropertiesService.getScriptProperties();
    var team = ["mail12@gmail.com", "mail13@gmail.com", "mail14@gmail.com", "mail15@gmail.com", "mail16@gmail.com"];
    
    var me = Session.getActiveUser().getEmail();
    var work_team = [];
    for(var i=0; i<team.length; i++) if(team[i] !== me) work_team.push(team[i]);

    var now = new Date();
    var today_str = now.toISOString().slice(0, 10).replace(/-/g, "_");
    var month_str = now.toISOString().slice(0, 7).replace(/-/g, "_");

    var storage_id = p.getProperty("STORAGE_FOLDER_ID");
    var folder;
    if (storage_id) { try { folder = DriveApp.getFolderById(storage_id); } catch(e) {} }
    if (!folder) {
      var folders = DriveApp.getFoldersByName("auto_share_for_connected_ai_studio");
      if (folders.hasNext()) folder = folders.next();
      else folder = DriveApp.createFolder("auto_share_for_connected_ai_studio");
      p.setProperty("STORAGE_FOLDER_ID", folder.getId());
    }
    storage_id = folder.getId();

    var last_log_day = p.getProperty("LOG_DATE_DAY");
    if (last_log_day && last_log_day !== today_str) {
      if (mail_daily_report === 1) {
        var y_content = read_drive_file(storage_id, "daily_log_" + last_log_day + ".txt");
        if (y_content && y_content.length > 5) {
          send_mail_logic(mail_target, team, "daily report at " + last_log_day + " for auto_share_for_connected_ai_studio", "Activity Log:\n\n" + y_content);
        }
      }
      p.setProperty("LOG_DATE_DAY", today_str);
    } else if (!last_log_day) p.setProperty("LOG_DATE_DAY", today_str);

    var last_log_month = p.getProperty("LOG_DATE_MONTH");
    if (last_log_month && last_log_month !== month_str) {
      if (mail_monthly_report === 1) {
        var m_content = read_drive_file(storage_id, "monthly_log_" + last_log_month + ".txt");
        if (m_content && m_content.length > 5) {
           var target = (mail_target === 0) ? 1 : mail_target;
           send_mail_logic(target, team, "monthly report at " + last_log_month + " for auto_share_for_connected_ai_studio", "Monthly Summary:\n\n" + m_content);
        }
      }
      p.setProperty("LOG_DATE_MONTH", month_str);
    } else if (!last_log_month) p.setProperty("LOG_DATE_MONTH", month_str);

    var k = "T_V8";
    var qt = p.getProperty(k) || "1970-01-01T00:00:00.000Z";
    if (force_full_check === 1) qt = "1970-01-01T00:00:00.000Z";
    var st = qt, total_up = 0;
    var f = DriveApp.getFoldersByName("Google AI Studio");
    var silent = (share_notification_silencer === 2 || (share_notification_silencer === 1 && force_full_check === 1));
    var run_errors = [];

    while (f.hasNext()) {
      var fid = f.next().getId(), page;
      do {
        var res = Drive.Files.list({
          q: "'" + fid + "' in parents and createdTime > '" + qt + "' and trashed = false",
          orderBy: "createdTime",
          fields: "nextPageToken, files(id, name, createdTime, permissions(emailAddress))",
          pageToken: page
        });
        var list = res.files;
        if (!list || list.length === 0) break;

        for (var i = 0; i < list.length; i++) {
          var item = list[i], cur = [];
          if (item.permissions) for (var j = 0; j < item.permissions.length; j++) cur.push(item.permissions[j].emailAddress);
          var add = [];
          for (var x = 0; x < work_team.length; x++) if (cur.indexOf(work_team[x]) < 0) add.push(work_team[x]);

          if (add.length > 0) {
            try {
              if (silent) {
                for (var z = 0; z < add.length; z++) {
                  Drive.Permissions.create({ role: 'editor', type: 'user', emailAddress: add[z] }, item.id, { sendNotificationEmail: false });
                }
              } else {
                DriveApp.getFileById(item.id).addEditors(add);
              }
              total_up++;
            } catch (e) {
              var err = "File: " + item.name + " (" + item.id + ") Error: " + e.message;
              console.error(err);
              run_errors.push(err);
              if (stop_at_error === 1) throw new Error("STOPPED by setting: " + err);
            }
          }
          if (item.createdTime > st) st = item.createdTime;
        }
        page = res.nextPageToken;
      } while (page);
    }

    if (st !== qt) p.setProperty(k, st);
    
    if (total_up > 0) {
      var ts = new Date().toTimeString().slice(0, 5);
      var entry = "\n[" + ts + "] Shared " + total_up + " files.";
      append_to_drive_file(storage_id, "daily_log_" + today_str + ".txt", entry);
      append_to_drive_file(storage_id, "monthly_log_" + month_str + ".txt", "\n[" + today_str + " " + ts + "] Shared " + total_up + " files.");
    }
    
    if (run_errors.length > 0 && alert_at_error === 1) {
      trigger_calendar_popup("🚨 Auto-Share Error!", "Errors found during run:\n" + run_errors.join("\n"));
    }

  } catch (critical_e) {
    if (alert_at_error === 1) trigger_calendar_popup("🚨 Script CRASHED!", critical_e.message);
  } finally {
    lock.releaseLock();
  }
}

function trigger_calendar_popup(title, description) {
  try {
    var now = new Date();
    var end = new Date(now.getTime() + 60000); 
    var event = CalendarApp.getDefaultCalendar().createEvent(title, now, end, { description: description });
    event.addPopupReminder(0); 
  } catch(e) {
    console.log("Calendar Alert Failed: " + e.message);
  }
}

function append_to_drive_file(folderId, filename, text) {
  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFilesByName(filename);
    if (files.hasNext()) {
      var file = files.next();
      file.setContent(file.getBlob().getDataAsString() + text);
    } else {
      folder.createFile(filename, text);
    }
  } catch(e) {}
}

function read_drive_file(folderId, filename) {
  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFilesByName(filename);
    if (files.hasNext()) return files.next().getBlob().getDataAsString();
  } catch(e) {}
  return "";
}

function send_mail_logic(mode, team_list, subject, body) {
  var rec = "";
  if (mode === 0) rec = Session.getActiveUser().getEmail();
  else if (mode === 1) rec = team_list.join(",");
  else if (typeof mode === "string" && mode.includes("@")) rec = mode;
  else rec = Session.getActiveUser().getEmail();
  
  if (rec) MailApp.sendEmail(rec, subject, body);
}
