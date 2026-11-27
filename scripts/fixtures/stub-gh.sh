#!/bin/sh

# Record every call for the test to read.
echo "$*" >> "$STUB_CALLS"
case "$1 $2" in

  # serve the requested files from STUB_RELEASE and fail on any missing one
  "release download")
    shift 2
    dir=""
    patterns=""

    # read the download folder and the requested file names
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) dir="$2"; shift 2 ;;
        --pattern) patterns="$patterns $2"; shift 2 ;;
        *) shift ;;
      esac
    done

    # copy each requested file into the download folder
    for pattern in $patterns; do
      [ -f "$STUB_RELEASE/$pattern" ] || { echo "release not found" >&2; exit 1; }
      cp "$STUB_RELEASE/$pattern" "$dir/"
    done
    ;;

  # pass attestation only when the test says so
  "attestation verify")
    [ "$STUB_ATTESTATION" = pass ] || { echo "verification failed" >&2; exit 1; }
    ;;
  *) exit 2 ;;
esac
