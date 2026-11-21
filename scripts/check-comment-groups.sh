#!/usr/bin/env bash
set -euo pipefail

# measure consecutive statement lines using the carlnotes limit
limit=8

# find a shell input delimiter outside comments and quoted arguments
match_heredoc() {
  local rest=$1 quote='' contexts='' character word_start=1
  local word='[a-zA-Z_][a-zA-Z_0-9]*'
  local opener="^<<(-?)[[:space:]]*('$word'|\"$word\"|$word)([[:space:];|&<>()]|$)"
  while [[ -n "$rest" ]]; do
    character=${rest:0:1}
    # consume quoted arguments and escaped characters as shell data
    if [[ "$character" == '\' && "$quote" != "'" ]]; then
      rest=${rest:2}
      word_start=0
      continue
    fi
    # enter shell code inside a command substitution, including double-quoted ones
    if [[ "$quote" != "'" && "${rest:0:2}" == '$(' ]]; then
      contexts="${quote:-u}$contexts"
      quote=''
      rest=${rest:2}
      word_start=1
      continue
    fi
    # keep quoted text literal until its closing quote
    if [[ -n "$quote" ]]; then
      if [[ "$character" == "$quote" ]]; then quote=''; fi
    else
      # preserve quoted arguments and stop at a shell comment
      case "$character" in
        "'"|'"') quote=$character; word_start=0 ;;
        '#') if (( word_start )); then return 1; fi ;;
        # capture the input delimiter and pass over here-strings
        '<')
          if [[ "$rest" == '<<<'* ]]; then rest=${rest:3}; word_start=1; continue; fi
          if [[ "$rest" =~ $opener ]]; then return 0; fi
          word_start=1 ;;
        # balance nested parentheses and restore quoting when the substitution ends
        '(') if [[ -n "$contexts" ]]; then contexts=u$contexts; fi; word_start=1 ;;
        ')')
          if [[ "${contexts:0:1}" == '"' ]]; then quote='"'; fi
          contexts=${contexts:1}
          word_start=1 ;;
        # recognize where a shell comment can begin
        [[:space:]]|';'|'|'|'&'|'>') word_start=1 ;;
        *) word_start=0 ;;
      esac
    fi
    # advance past the character examined above
    rest=${rest:1}
  done
  return 1
}

check_file() {
  local file=$1 marker line trimmed delimiter='' in_import=0 in_block=0
  local number=0 run=0 longest=0 start=0 strip_tabs='' terminator
  local named_import='^import[[:space:]]+((type|[[:alnum:]_$]+,)[[:space:]]+)?\{'

  # select the comment syntax for this source file
  case "$file" in
    *.ts|*.mts|*.js|*.mjs) marker='//' ;;
    *.sh) marker='#' ;;
    *) return 0 ;;
  esac
  [[ -f "$file" && ! -L "$file" ]] || return 0

  # include a final line without a trailing newline
  while IFS= read -r line || [[ -n "$line" ]]; do
    number=$((number + 1))
    trimmed="${line#"${line%%[![:space:]]*}"}"

    # skip literal input passed to another command by a shell heredoc
    if [[ -n "$delimiter" ]]; then
      terminator=$line
      if [[ -n "$strip_tabs" ]]; then terminator="${line#"${line%%[!$'\t']*}"}"; fi
      if [[ "$terminator" == "$delimiter" ]]; then delimiter=''; fi
      continue
    fi

    # skip the rest of a javascript block comment or wrapped import
    if (( in_block )); then
      if [[ "$trimmed" == *'*/'* ]]; then in_block=0; fi
      continue
    elif (( in_import )); then
      if [[ "$trimmed" == *'}'* ]]; then in_import=0; fi
      continue
    fi

    # start a new group after whitespace or a full-line comment
    if [[ -z "$trimmed" || "$trimmed" == "$marker"* ]]; then
      run=0
      continue
    fi

    # recognize continuations and documentation in javascript and typescript
    if [[ "$marker" == '//' ]]; then
      case "$trimmed" in
        # treat a wrapped import as a single declaration
        'import '*) run=0
          if [[ "$trimmed" =~ $named_import && "$trimmed" != *'}'* ]]; then in_import=1; fi
          continue ;;
        '/*'*) run=0; [[ "$trimmed" == *'*/'* ]] || in_block=1; continue ;;
        '{/*'*|*,) run=0; continue ;;
      esac
    elif [[ "$trimmed" == *'<<'* ]] && match_heredoc "$trimmed"; then
      # remember which line ends the shell input
      strip_tabs=${BASH_REMATCH[1]}
      delimiter=${BASH_REMATCH[2]}
      delimiter=${delimiter//[\'\"]/}
      run=0
      continue
    fi

    # remember the start of the longest run for the editor diagnostic
    run=$((run + 1))
    if (( run > longest )); then
      longest=$run
      start=$((number - run + 1))
    fi
  done < "$file" || return 2

  # report a blocking hook error with the file's comment syntax
  if (( longest > limit )); then
    printf 'comment-groups: %q:%d: %d consecutive uncommented lines (limit %d). Add a %s comment above each logical group.\n' \
      "$file" "$start" "$longest" "$limit" "$marker" >&2
    return 2
  fi
}

# check every tracked source path and report all failing files
if [[ ${1:-} == --tracked ]]; then
  cd "$(git rev-parse --show-toplevel)"
  git ls-files --cached -z | (
    status=0
    # keep file names intact, including spaces and newlines
    while IFS= read -r -d '' file; do
      check_file "$file" || status=$?
    done
    exit "$status"
  )
elif (( $# )); then
  # check one explicit path for local use
  check_file "$1"
else
  # resolve the edited path from the claude code hook event
  command -v jq >/dev/null || { echo "comment-groups: install jq for hook mode" >&2; exit 2; }
  file=$(jq -er '.tool_input.file_path | strings | select(length > 0)') || {
    echo "comment-groups: expected tool_input.file_path in hook input" >&2
    exit 2
  }
  check_file "$file"
fi
