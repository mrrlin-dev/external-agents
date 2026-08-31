#!/usr/bin/env bash
# Install (or remove) the daily pool check.
#
#   scripts/install-doctor-schedule.sh              # install, default 09:15 local
#   scripts/install-doctor-schedule.sh --at 21:00   # install at a different time
#   scripts/install-doctor-schedule.sh --run        # install and run once, now
#   scripts/install-doctor-schedule.sh --status     # is it loaded, and what did it last say
#   scripts/install-doctor-schedule.sh --uninstall
#
# launchd on macOS, `crontab` elsewhere. The job itself is scripts/doctor-daily.sh,
# which measures first and judges second — see the header there.
set -euo pipefail

LABEL="com.mrrlin.external-agents-doctor"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JOB="${HERE}/doctor-daily.sh"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
REPORT_DIR="${HOME}/.local/state/external-agents/doctor"
LOG_DIR="${REPORT_DIR}/launchd"

AT="09:15"
ACTION="install"
RUN_NOW=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --at) AT="${2:?--at needs HH:MM}"; shift 2 ;;
    --run) RUN_NOW=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --status) ACTION="status"; shift ;;
    -h|--help)
      awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f "${JOB}" ]] || { echo "missing job script: ${JOB}" >&2; exit 1; }
chmod +x "${JOB}"

if [[ "${AT}" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
  HOUR="$((10#${BASH_REMATCH[1]}))"
  MINUTE="$((10#${BASH_REMATCH[2]}))"
  ((HOUR >= 0 && HOUR <= 23 && MINUTE >= 0 && MINUTE <= 59)) || { echo "--at out of range: ${AT}" >&2; exit 2; }
else
  echo "--at must look like HH:MM (got '${AT}')" >&2; exit 2
fi

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }

case "${ACTION}" in
status)
  if is_macos; then
    if launchctl list 2>/dev/null | grep -q "${LABEL}"; then
      echo "loaded:   yes (${LABEL})"
      # Column 1 of `launchctl list` is the last exit status. 1 means the last
      # run found a high-severity regression, which is information, not breakage.
      launchctl list | awk -v l="${LABEL}" '$3==l {print "last rc: " $2}'
    else
      echo "loaded:   no"
    fi
    [[ -f "${PLIST}" ]] && echo "plist:    ${PLIST}" || echo "plist:    (absent)"
  else
    crontab -l 2>/dev/null | grep -F "${JOB}" >/dev/null \
      && echo "crontab:  installed" || echo "crontab:  not installed"
  fi
  if [[ -f "${REPORT_DIR}/latest.txt" ]]; then
    echo "latest:   ${REPORT_DIR}/latest.txt"
    echo ""
    sed -n '1,6p' "${REPORT_DIR}/latest.txt"
  else
    echo "latest:   (no report yet)"
  fi
  exit 0
  ;;

uninstall)
  if is_macos; then
    launchctl unload "${PLIST}" 2>/dev/null || true
    rm -f "${PLIST}"
    echo "removed:  ${PLIST}"
  else
    crontab -l 2>/dev/null | grep -vF "${JOB}" | crontab - || true
    echo "removed:  crontab entry for ${JOB}"
  fi
  echo "note:     reports under ${REPORT_DIR} were left in place."
  exit 0
  ;;
esac

# ---- install ---------------------------------------------------------------
mkdir -p "${LOG_DIR}"

if is_macos; then
  mkdir -p "$(dirname "${PLIST}")"
  # StandardOut/Error are the launchd-level capture — the job writes its own
  # report regardless, so these only ever matter when the script itself cannot
  # start (a missing interpreter, a permissions problem).
  cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${JOB}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${HOUR}</integer>
    <key>Minute</key><integer>${MINUTE}</integer>
  </dict>
  <key>StandardOutPath</key><string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
PLIST_EOF
  launchctl unload "${PLIST}" 2>/dev/null || true
  launchctl load "${PLIST}"
  echo "installed: ${LABEL} — daily at ${AT} local"
  echo "plist:     ${PLIST}"
else
  LINE="${MINUTE} ${HOUR} * * * /bin/bash ${JOB} >> ${LOG_DIR}/cron.log 2>&1"
  (crontab -l 2>/dev/null | grep -vF "${JOB}"; echo "${LINE}") | crontab -
  echo "installed: crontab entry — daily at ${AT} local"
fi

echo "reports:   ${REPORT_DIR}/  (latest.txt, plus one dated .txt/.json per day)"
echo "check it:  scripts/install-doctor-schedule.sh --status"

if [[ ${RUN_NOW} -eq 1 ]]; then
  echo ""
  echo "── running once now ─────────────────────────────────────────────────"
  # The job exits 1 on a high-severity finding, which is a finding and not an
  # installer failure, so `set -e` must not treat it as one.
  /bin/bash "${JOB}" || true
  echo ""
  sed -n '1,40p' "${REPORT_DIR}/latest.txt" 2>/dev/null || true
fi
