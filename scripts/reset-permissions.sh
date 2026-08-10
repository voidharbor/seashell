#!/bin/bash
#
# Stop macOS asking for the same permission every time SeaShell launches.
#
# Original by Josh's father, who hit this on 0.2.6 and worked out the fix
# before the cause was understood. Adapted here with one behaviour change,
# explained below.
#
# THE CAUSE, and why you may not need this
# ----------------------------------------
# macOS remembers a permission against an app's code signature. Builds up to
# and including 0.2.7 shipped UNSIGNED — `electron-builder.yml` set
# `mac.identity: null`, which tells electron-builder to skip signing entirely,
# directly underneath a comment saying arm64 needs at least an ad-hoc
# signature. With nothing to remember the app by, macOS forgets the approval
# and asks again on the next launch. Every launch.
#
# 0.2.8 fixed that: the build is ad-hoc signed and its designated requirement
# is a stable cdhash, so an approval sticks. On 0.4.0 or later you should be
# able to approve once and never see the prompt again.
#
# So: install the current release first and see whether the problem is simply
# gone. Run this only if a prompt still repeats, which usually means a stale
# record left behind by an older, unsigned install of the same bundle id.
#
# WHAT CHANGED FROM THE ORIGINAL
# ------------------------------
# The original always re-signed the app. That was right when the app arrived
# unsigned, and is now counterproductive: `codesign --force --deep --sign -`
# on an already-signed bundle produces a DIFFERENT cdhash, which throws away
# the approval you are trying to keep and causes one more prompt. Measured on
# 0.4.0: 9ecbbbce… before, 147bd52c… after. So the signature is now applied
# only when the app does not already have one.
#
# This script uses no sudo, does not touch Gatekeeper, and resets exactly one
# permission for exactly one app.

set -u

APP_NAME="SeaShell"
APP="/Applications/${APP_NAME}.app"

# Which permission to clear. Documents is the one this usually is; pass another
# service name to clear a different one, e.g.
#   ./reset-permissions.sh SystemPolicyDesktopFolder
SERVICE="${1:-SystemPolicyDocumentsFolder}"

if [ ! -d "${APP}" ]; then
    echo "${APP} not found."
    exit 1
fi

# Quit it first: re-signing or resetting under a running app is asking for a
# half-applied state. `pgrep -x` matches the process name and does see it —
# note that `pgrep -f` does NOT, which has fooled scripts before.
if pgrep -x "${APP_NAME}" > /dev/null 2>&1; then
    echo "Quitting ${APP_NAME}..."
    osascript -e "tell application \"${APP_NAME}\" to quit" > /dev/null 2>&1
    sleep 2
    pkill -x "${APP_NAME}" > /dev/null 2>&1
fi

# Downloaded copies carry a quarantine flag. Nothing to do if you copied the
# app across by USB or scp, which never sets it.
echo "Removing quarantine attribute..."
xattr -dr com.apple.quarantine "${APP}" 2>/dev/null

# Only sign if it is not signed. Re-signing a signed app changes its identity
# and undoes the thing this script exists to fix.
if codesign -dv "${APP}" > /dev/null 2>&1; then
    echo "Already signed — leaving the signature alone."
    echo "  (Re-signing would change the cdhash and re-trigger the prompt.)"
else
    echo "Unsigned build. Applying an ad-hoc signature..."
    if ! codesign --force --deep --sign - "${APP}" 2>&1; then
        echo "Signing failed. Grant the permission manually in System Settings >"
        echo "Privacy & Security instead."
    fi
fi

BUNDLE_ID="$(defaults read "${APP}/Contents/Info.plist" CFBundleIdentifier 2>/dev/null)"
if [ -z "${BUNDLE_ID}" ]; then
    BUNDLE_ID="$(codesign -dv "${APP}" 2>&1 | awk -F= '/^Identifier=/{print $2}')"
fi
if [ -z "${BUNDLE_ID}" ]; then
    echo "Could not determine a bundle identifier."
    echo "Remove the ${APP_NAME} entry manually in System Settings >"
    echo "Privacy & Security, then relaunch."
    exit 1
fi
echo "Bundle identifier: ${BUNDLE_ID}"

echo "Clearing the ${SERVICE} record..."
tccutil reset "${SERVICE}" "${BUNDLE_ID}" 2>/dev/null \
    || echo "No record found for that identifier. Clear it manually if the prompt persists."

echo ""
echo "Done. Launch ${APP_NAME} and approve the prompt once. It should not come back"
echo "until the next version, which is a different build and so a different signature."
