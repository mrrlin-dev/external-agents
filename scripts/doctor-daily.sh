#!/usr/bin/env bash
# Daily pool check: measure, then judge.
#
# Two steps, in this order, and the order is the point:
#
#   1. audit   — one `max_tokens: 1` ping per HTTP entry. Cheap, and it is what
#                MEASURES things: the probe response carries the provider's real
#                rate-limit ceiling, which is how a seat stops being a guess.
#                It also settles liveness and clears the quarantine on anything
#                that has started answering again.
#   2. doctor  — judges the last 24h of telemetry against the five goals in
#                README. Because step 1 just ran, the most common finding
#                ("this seat has no measured ceiling") is usually already fixed
#                rather than merely reported. A watchdog that fixes what it can
#                is worth having; one that only complains gets muted.
#
# Exit code is the doctor's: 1 on a high-severity finding, 0 otherwise. Only a
# high finding raises a desktop notification, for the same reason.
set -uo pipefail

STATE_DIR="${HOME}/.local/state/external-agents"
REPORT_DIR="${STATE_DIR}/doctor"
RETENTION_DAYS="${EXTERNAL_AGENTS_DOCTOR_RETENTION_DAYS:-30}"
WINDOW="${EXTERNAL_AGENTS_DOCTOR_WINDOW:-24h}"

mkdir -p "${REPORT_DIR}"
chmod 0700 "${STATE_DIR}" "${REPORT_DIR}" 2>/dev/null || true

# launchd hands over a minimal PATH, so nothing here may assume a login shell.
# Prefer an explicit override, then the installed binary, then a repo checkout —
# and say which one was used, because "the daily job was testing a stale build"
# is otherwise invisible.
resolve_cli() {
  if [[ -n "${EXTERNAL_AGENTS_CLI:-}" ]]; then echo "${EXTERNAL_AGENTS_CLI}"; return; fi
  for candidate in \
      "$(command -v external-agents 2>/dev/null || true)" \
      "${HOME}/.local/bin/external-agents" \
      "/opt/homebrew/bin/external-agents" \
      "/usr/local/bin/external-agents"; do
    [[ -n "${candidate}" && -x "${candidate}" ]] && { echo "${candidate}"; return; }
  done
  return 1
}

CLI="$(resolve_cli || true)"
if [[ -z "${CLI}" ]]; then
  # A missing CLI is a setup problem, not a pool finding. Record it where the
  # reports live so it cannot fail silently every night for a month.
  {
    echo "external-agents doctor — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo ""
    echo "SETUP ERROR: no external-agents binary found on PATH or at the usual"
    echo "locations. Set EXTERNAL_AGENTS_CLI to its absolute path and re-install"
    echo "the schedule:  scripts/install-doctor-schedule.sh"
  } | tee "${REPORT_DIR}/latest.txt"
  exit 2
fi

# Does the resolved CLI actually have `doctor`? An installed build older than
# 0.53.0 does not, and would answer with "unknown subcommand" — a nightly job
# failing for that reason must say so in one line instead of leaving the operator
# to read an exit code.
#
# Probed via `doctor --help`, which prints help and runs nothing. That is only
# safe because 0.51.1 fixed subcommand help: before it, `<subcommand> --help`
# EXECUTED the subcommand, and a feature probe written this way silently read the
# wrong answer and dropped the flag it was testing for.
#
# The pattern matters as much as the command. Grepping for `--since` looked
# obvious and was WRONG — an old build prints its whole help, which advertises
# `--since` for `stats`, so the probe passed on a build with no doctor at all.
# Caught while testing this script against the installed 0.52.1. Match a string
# that exists nowhere but the doctor block.
if ! "${CLI}" doctor --help 2>&1 | grep -q "five goals"; then
  {
    echo "external-agents doctor — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "cli: ${CLI}"
    echo "version: $("${CLI}" --version 2>/dev/null || echo unknown)"
    echo ""
    echo "SETUP ERROR: this build has no 'doctor' subcommand (needs >= 0.53.0)."
    echo "Upgrade the installed package, or point EXTERNAL_AGENTS_CLI at a checkout"
    echo "that has it, then re-install the schedule."
  } | tee "${REPORT_DIR}/latest.txt"
  exit 2
fi

STAMP="$(date -u '+%Y-%m-%d')"
REPORT="${REPORT_DIR}/${STAMP}.txt"

{
  echo "external-agents doctor — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "cli: ${CLI}"
  echo "version: $("${CLI}" --version 2>/dev/null || echo unknown)"
  echo ""
  echo "── step 1: audit (measure ceilings, settle liveness) ────────────────"
  # Never allowed to fail the run. An audit is a network operation against a
  # dozen providers; one of them being down tonight says nothing about whether
  # the pool meets its goals, which is what step 2 is for.
  "${CLI}" audit 2>&1 || echo "(audit exited non-zero — continuing to the checks)"
  echo ""
  echo "── step 2: doctor (judge the last ${WINDOW}) ────────────────────────"
} > "${REPORT}" 2>&1

"${CLI}" doctor --since "${WINDOW}" >> "${REPORT}" 2>&1
DOCTOR_RC=$?

# Machine-readable alongside the prose, so a later session can diff windows
# without re-parsing a report meant for a human.
"${CLI}" doctor --since "${WINDOW}" --json > "${REPORT_DIR}/${STAMP}.json" 2>/dev/null

cp -f "${REPORT}" "${REPORT_DIR}/latest.txt" 2>/dev/null || true

# Prune. The reports are small but this runs every night forever; an unbounded
# directory is the same mistake the dispatch log already made.
find "${REPORT_DIR}" -maxdepth 1 -type f \( -name '20*.txt' -o -name '20*.json' \) \
  -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

if [[ ${DOCTOR_RC} -ne 0 ]]; then
  # Only a high-severity finding gets here, so it is allowed to interrupt.
  SUMMARY="$(grep -m3 '^✗' "${REPORT}" | sed 's/^✗ //' | tr '\n' ';' || true)"
  osascript -e "display notification \"${SUMMARY:-see the report}\" with title \"external-agents pool regressed\"" 2>/dev/null || true
  echo "doctor: high-severity finding — ${REPORT}" >&2
fi

exit ${DOCTOR_RC}
