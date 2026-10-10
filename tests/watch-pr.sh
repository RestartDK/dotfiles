#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
watch_bin=${WATCH_PR_BIN:-$root/config/agents/skills/dstack/dstack-mode/scripts/watch-pr}
test_bash=${WATCH_PR_TEST_BASH:-$(command -v bash)}
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin"
fixtures=$test_dir/fixtures

printf '#!%s\n' "$test_bash" >"$test_dir/bin/gh"
cat >>"$test_dir/bin/gh" <<'EOF'
set -u
case "$*" in
"api user -q .login") printf 'RestartDK\n' ;;
"repo view --json nameWithOwner -q .nameWithOwner") printf 'twin-so/cobb\n' ;;
"pr view "*)
  if [[ -f "$WATCH_PR_TEST_CASE_DIR/poll" ]]; then
    read -r poll <"$WATCH_PR_TEST_CASE_DIR/poll"
    poll=$((poll + 1))
    printf '%s\n' "$poll" >"$WATCH_PR_TEST_CASE_DIR/poll"
    cat "$WATCH_PR_TEST_CASE_DIR/view-$poll.json"
  else
    cat "$WATCH_PR_TEST_CASE_DIR/view.json"
  fi
  ;;
"api graphql "*) cat "$WATCH_PR_TEST_CASE_DIR/threads.json" ;;
*)
  printf 'unexpected gh call: %s\n' "$*" >&2
  exit 1
  ;;
esac
EOF
chmod +x "$test_dir/bin/gh"
export PATH="$test_dir/bin:$PATH"

fixture_dir=""
view() {
  cat >"$fixture_dir/view.json"
}

threads() {
  jq '
    if .data.repository.pullRequest.reviewThreads != null then
      .data.repository.pullRequest.reviewThreads |= (
        .pageInfo //= {hasNextPage:false}
        | .nodes |= map(.comments |= (
          .pageInfo //= {hasNextPage:false}
          | .nodes |= map(.reactions.pageInfo //= {hasNextPage:false})
        ))
      )
    else . end
  ' >"$fixture_dir/threads.json"
}

fixture() {
  fixture_dir=$fixtures/$1
  mkdir -p "$fixture_dir"
  export WATCH_PR_TEST_CASE_DIR=$fixture_dir
  view <<'JSON'
{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[],"isDraft":false}
JSON
}

last_output=""
last_status=0

invoke() {
  if last_output=$("$test_bash" "$watch_bin" "$@" 2>&1); then
    last_status=0
  else
    last_status=$?
  fi
}

assert_status() {
  local expected=$1 label=$2
  if [[ $last_status -ne $expected ]]; then
    printf 'FAIL %s: expected status %s, got %s\n%s\n' "$label" "$expected" "$last_status" "$last_output" >&2
    exit 1
  fi
}

assert_eq() {
  local expected=$1 actual=$2 label=$3
  if [[ $actual != "$expected" ]]; then
    printf 'FAIL %s\nexpected: <%s>\nactual:   <%s>\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

assert_failure() {
  local label=$1
  if [[ $last_status -eq 0 ]]; then
    printf 'FAIL %s: expected failure\n%s\n' "$label" "$last_output" >&2
    exit 1
  fi
}

assert_contains() {
  local needle=$1 haystack=$2 label=$3
  if [[ $haystack != *"$needle"* ]]; then
    printf 'FAIL %s: missing <%s>\n%s\n' "$label" "$needle" "$haystack" >&2
    exit 1
  fi
}

assert_jq() {
  local expected=$1 filter=$2 label=$3
  assert_eq "$expected" "$(jq -r "$filter" <<<"$last_output")" "$label"
}

fixture bot
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Bug\nhere","createdAt":"2026-01-01T00:00:00Z","author":{"login":"bugbot","__typename":"Bot"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "bot thread status"
assert_jq THREADS '.verdict' "bot thread verdict"
assert_jq bot '.threads[0].kind' "bot thread kind"
assert_jq bugbot '.threads[0].author' "bot thread author"
assert_jq 'https://github.com/twin-so/cobb/pull/42#discussion_r1' '.threads[0].url' "bot thread url"
assert_jq 'Bug here' '.threads[0].body' "bot thread body collapse"
assert_jq null '.threads[0].decision' "bot thread decision"
assert_jq 1 '.unresolved_threads' "bot thread count"
assert_jq 0 '.human_pending' "bot thread human pending count"

fixture owner
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Please split this","createdAt":"2026-01-01T00:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "owner thread status"
assert_jq THREADS '.verdict' "owner thread verdict"
assert_jq owner '.threads[0].kind' "owner thread kind"
assert_jq null '.threads[0].decision' "owner thread decision"

invoke 42 --status-only
assert_status 0 "default me and repo status"
assert_jq THREADS '.verdict' "default me and repo verdict"
assert_jq owner '.threads[0].kind' "default me from gh api user"
assert_jq twin-so/cobb '.repo' "default repo from gh repo view"

fixture unanswered
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "human unanswered status"
assert_jq THREADS '.verdict' "human unanswered verdict"
assert_jq human '.threads[0].kind' "human unanswered kind"
assert_jq unanswered '.threads[0].decision' "human unanswered decision"
assert_jq 0 '.human_pending' "human unanswered human pending count"

fixture pending
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "human pending status"
assert_jq HUMAN_PENDING '.verdict' "human pending verdict"
assert_jq human '.threads[0].kind' "human pending kind"
assert_jq pending '.threads[0].decision' "human pending decision"
assert_jq 1 '.human_pending' "human pending count"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only --pretty
assert_status 0 "human pending pretty status"
assert_contains 'human_pending=1' "$last_output" "human pending pretty summary"
assert_contains '  human pending alice https://github.com/twin-so/cobb/pull/42#discussion_r1' "$last_output" "human pending pretty thread line"

fixture thumb_up
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[{"content":"THUMBS_UP","createdAt":"2026-01-01T02:00:00Z","user":{"login":"RestartDK"}}]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "thumbs up status"
assert_jq THREADS '.verdict' "thumbs up verdict"
assert_jq implement '.threads[0].decision' "thumbs up decision"

fixture thumb_down
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[{"content":"THUMBS_DOWN","createdAt":"2026-01-01T02:00:00Z","user":{"login":"RestartDK"}}]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "thumbs down status"
assert_jq THREADS '.verdict' "thumbs down verdict"
assert_jq skip '.threads[0].decision' "thumbs down decision"

fixture reaction_latest
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T09:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[{"content":"THUMBS_DOWN","createdAt":"2026-01-01T11:00:00Z","user":{"login":"RestartDK"}},{"content":"THUMBS_UP","createdAt":"2026-01-01T10:00:00Z","user":{"login":"RestartDK"}}]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "latest reaction status"
assert_jq THREADS '.verdict' "latest reaction verdict"
assert_jq skip '.threads[0].decision' "latest reaction wins"

fixture direction
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r3","body":"Rename the field\nto x","createdAt":"2026-01-01T02:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "direction status"
assert_jq THREADS '.verdict' "direction verdict"
assert_jq direction '.threads[0].decision' "direction decision"
assert_jq 'Rename the field to x' '.threads[0].direction' "direction body"

fixture fixed_in
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r3","body":"Fixed in abc123: renamed the field","createdAt":"2026-01-01T02:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "fixed in status"
assert_jq HUMAN_PENDING '.verdict' "fixed in verdict"
assert_jq pending '.threads[0].decision' "fixed in reply is not direction"
assert_jq 1 '.human_pending' "fixed in human pending count"

jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[2].body = "[🫩 Daniel\u0027s Agent]\nFixed in abc123: renamed the field"' "$fixture_dir/threads.json" >"$fixture_dir/prefixed.json"
mv "$fixture_dir/prefixed.json" "$fixture_dir/threads.json"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_jq pending '.threads[0].decision' "agent-prefixed fix reply is not author direction"

jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].reactions.nodes = [{content:"THUMBS_UP",createdAt:"2026-01-01T00:30:00Z",user:{login:"RestartDK"}}]' "$fixture_dir/threads.json" >"$fixture_dir/old-reaction.json"
mv "$fixture_dir/old-reaction.json" "$fixture_dir/threads.json"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_jq pending '.threads[0].decision' "approval before the gated verdict cannot authorize code changes"

jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true' "$fixture_dir/threads.json" >"$fixture_dir/incomplete.json"
mv "$fixture_dir/incomplete.json" "$fixture_dir/threads.json"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_failure "truncated comments cannot preserve obsolete approval"
assert_contains "Incomplete review observation" "$last_output" "pagination error stays visible"

fixture direction_reaction
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[{"content":"THUMBS_UP","createdAt":"2026-01-01T03:00:00Z","user":{"login":"RestartDK"}}]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r3","body":"Rename the field\nto x","createdAt":"2026-01-01T02:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "direction reaction status"
assert_jq implement '.threads[0].decision' "direction reaction decision"
assert_jq 'Rename the field to x' '.threads[0].direction' "direction reaction body"
jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[2].createdAt = "2026-01-01T04:00:00Z"' "$fixture_dir/threads.json" >"$fixture_dir/new-direction.json"
mv "$fixture_dir/new-direction.json" "$fixture_dir/threads.json"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_jq direction '.threads[0].decision' "later author direction supersedes an earlier reaction"

fixture mixed
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Is this reachable?","createdAt":"2026-01-01T00:00:00Z","author":{"login":"alice","__typename":"User"},"reactions":{"nodes":[]}},
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r2","body":"Checking with the author before changing anything","createdAt":"2026-01-01T01:00:00Z","author":{"login":"RestartDK","__typename":"User"},"reactions":{"nodes":[]}}
  ]}},
  {"id":"T2","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r3","body":"Bug here","createdAt":"2026-01-01T00:00:00Z","author":{"login":"bugbot","__typename":"Bot"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "mixed threads status"
assert_jq THREADS '.verdict' "mixed threads verdict"
assert_jq 2 '.unresolved_threads' "mixed threads count"
assert_jq 1 '.human_pending' "mixed threads human pending count"
assert_eq '["human","bot"]' "$(jq -c '[.threads[].kind]' <<<"$last_output")" "mixed threads kinds"

fixture conflict
view <<'JSON'
{"state":"OPEN","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY","reviewDecision":"APPROVED","statusCheckRollup":[],"isDraft":false}
JSON
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Bug here","createdAt":"2026-01-01T00:00:00Z","author":{"login":"bugbot","__typename":"Bot"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "conflict status"
assert_jq CONFLICT '.verdict' "conflict beats threads"

fixture merged
view <<'JSON'
{"state":"MERGED","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN","reviewDecision":"APPROVED","statusCheckRollup":[{"name":"build","conclusion":"FAILURE"}],"isDraft":false}
JSON
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Bug here","createdAt":"2026-01-01T00:00:00Z","author":{"login":"bugbot","__typename":"Bot"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "merged status"
assert_jq MERGED '.verdict' "merged beats everything"

fixture truncation
long_body=$(printf 'x%.0s' {1..500})
threads <<JSON
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"$long_body","createdAt":"2026-01-01T00:00:00Z","author":{"login":"bugbot","__typename":"Bot"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "truncation status"
assert_jq 400 '.threads[0].body | length' "body length capped"
assert_jq true '.threads[0].body == ("x" * 400)' "body truncated to 400"

fixture bot_suffix
threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T1","isResolved":false,"isOutdated":false,"comments":{"nodes":[
    {"url":"https://github.com/twin-so/cobb/pull/42#discussion_r1","body":"Bump the dependency","createdAt":"2026-01-01T00:00:00Z","author":{"login":"dependabot[bot]","__typename":"User"},"reactions":{"nodes":[]}}
  ]}}
]}}}}}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "bot suffix status"
assert_jq THREADS '.verdict' "bot suffix verdict"
assert_jq bot '.threads[0].kind' "bot suffix kind"

for kind in bot owner; do
  fixture "author-update-$kind"
  login=bugbot typename=Bot
  if [[ $kind == owner ]]; then login=RestartDK typename=User; fi
  jq -cn --arg login "$login" --arg typename "$typename" '
    {data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:"T1",isResolved:false,isOutdated:false,comments:{nodes:[
      {id:"C1",url:"https://example.invalid/root",body:"Fix the predicate",createdAt:"2026-01-01T00:00:00Z",author:{login:$login,__typename:$typename},reactions:{nodes:[]}}
    ]}}]}}}}}' | threads
  invoke 42 --me RestartDK --agent-login RestartDK --repo twin-so/cobb --status-only
  before_authority=$(jq -c '.threads[0].approval' <<<"$last_output")
  jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes += [
    {id:"C2",url:"https://example.invalid/direction",body:"Do not implement this.",createdAt:"2026-01-01T01:00:00Z",updatedAt:"2026-01-01T02:00:00Z",author:{login:"RestartDK",__typename:"User"},reactions:{nodes:[],pageInfo:{hasNextPage:false}}}
  ]' "$fixture_dir/threads.json" >"$fixture_dir/changed.json"
  mv "$fixture_dir/changed.json" "$fixture_dir/threads.json"
  invoke 42 --me RestartDK --agent-login RestartDK --repo twin-so/cobb --status-only
  assert_status 0 "$kind author withdrawal status"
  assert_jq 'Do not implement this.' '.threads[0].approval.author_updates[-1].body' "$kind full author direction is bound"
  if [[ $(jq -c '.threads[0].approval' <<<"$last_output") == "$before_authority" ]]; then
    printf 'FAIL %s author withdrawal did not change authority\n' "$kind" >&2
    exit 1
  fi
  jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes += [
    {id:"C3",url:"https://example.invalid/agent",body:"[🫩 Daniel\u0027s Agent]\nOperational reply",createdAt:"2026-01-01T03:00:00Z",author:{login:"RestartDK",__typename:"User"},reactions:{nodes:[],pageInfo:{hasNextPage:false}}}
  ]' "$fixture_dir/threads.json" >"$fixture_dir/changed.json"
  mv "$fixture_dir/changed.json" "$fixture_dir/threads.json"
  authority=$(jq -c '.threads[0].approval' <<<"$last_output")
  invoke 42 --me RestartDK --agent-login RestartDK --repo twin-so/cobb --status-only
  assert_eq "$authority" "$(jq -c '.threads[0].approval' <<<"$last_output")" "$kind agent reply is not author withdrawal"
done

fixture edited_long_direction
jq -cn '
  {data:{repository:{pullRequest:{reviewThreads:{nodes:[{id:"T1",isResolved:false,isOutdated:false,comments:{nodes:[
    {id:"C1",url:"https://example.invalid/root",body:"Fix code",createdAt:"2026-01-01T00:00:00Z",author:{login:"alice",__typename:"User"},reactions:{nodes:[]}},
    {id:"C2",url:"https://example.invalid/gate",body:"[🫩 Daniel\u0027s Agent]\nChecking with the author before changing anything",createdAt:"2026-01-01T01:00:00Z",author:{login:"RestartDK",__typename:"User"},reactions:{nodes:[{id:"R1",content:"THUMBS_UP",createdAt:"2026-01-01T02:00:00Z",user:{login:"RestartDK"}}]}},
    {id:"C3",url:"https://example.invalid/direction",body:(("x"*420)+" implement"),createdAt:"2026-01-01T01:30:00Z",updatedAt:"2026-01-01T01:30:00Z",author:{login:"RestartDK",__typename:"User"},reactions:{nodes:[]}}
  ]}}]}}}}}' | threads
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_jq implement '.threads[0].decision' "later reaction precedence"
authority=$(jq -c '.threads[0].approval' <<<"$last_output")
jq '.data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[2] |= (.body = (("x"*420)+" do not implement") | .updatedAt="2026-01-01T03:00:00Z")' "$fixture_dir/threads.json" >"$fixture_dir/changed.json"
mv "$fixture_dir/changed.json" "$fixture_dir/threads.json"
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_status 0 "edited long direction status"
assert_jq direction '.threads[0].decision' "direction edit takes precedence over old reaction"
assert_jq true '.threads[0].approval.author_updates[-1].body | endswith("do not implement")' "full direction beyond display limit is bound"
if [[ $(jq -c '.threads[0].approval' <<<"$last_output") == "$authority" ]]; then
  printf 'FAIL edited long direction did not change authority\n' >&2
  exit 1
fi

fixture graphql_error
threads <<'JSON'
{"errors":[{"message":"MAX_NODE_LIMIT_EXCEEDED"}]}
JSON
invoke 42 --me RestartDK --repo twin-so/cobb --status-only
assert_failure "graphql error"
assert_contains "MAX_NODE_LIMIT_EXCEEDED" "$last_output" "graphql error message"

for waiting in READY REVIEW_REQUIRED; do
  for outcome in MERGED CLOSED CI_FAIL CHANGES_REQUESTED; do
    fixture "lifecycle-$waiting-$outcome"
    threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}
JSON
    if [[ $waiting == REVIEW_REQUIRED ]]; then
      view <<'JSON'
{"state":"OPEN","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":[],"isDraft":false}
JSON
    fi
    cp "$fixture_dir/view.json" "$fixture_dir/view-1.json"
    cp "$fixture_dir/view.json" "$fixture_dir/view-2.json"
    case $outcome in
    MERGED | CLOSED)
      jq --arg state "$outcome" '.state = $state' "$fixture_dir/view.json" >"$fixture_dir/view-3.json"
      verdict=$outcome
      ;;
    CI_FAIL)
      jq '.statusCheckRollup = [{"name":"build","conclusion":"FAILURE"}]' "$fixture_dir/view.json" >"$fixture_dir/view-3.json"
      verdict=CI_FAIL
      ;;
    CHANGES_REQUESTED)
      jq '.reviewDecision = "CHANGES_REQUESTED"' "$fixture_dir/view.json" >"$fixture_dir/view-3.json"
      verdict=REVIEW
      ;;
    esac
    printf '0\n' >"$fixture_dir/poll"
    invoke 42 --me RestartDK --repo twin-so/cobb --interval 0
    assert_status 0 "$waiting to $outcome status"
    assert_eq 3 "$(jq -s 'length' <<<"$last_output")" "$waiting stays armed across repeated snapshots"
    assert_eq "$verdict" "$(jq -sr 'last.verdict' <<<"$last_output")" "$waiting wakes on $outcome"
  done
done

for outcome in MERGED CLOSED; do
  fixture "deferred-conflict-$outcome"
  threads <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}
JSON
  jq '.mergeable = "CONFLICTING"' "$fixture_dir/view.json" >"$fixture_dir/view-1.json"
  cp "$fixture_dir/view-1.json" "$fixture_dir/view-2.json"
  jq --arg state "$outcome" '.state = $state' "$fixture_dir/view.json" >"$fixture_dir/view-3.json"
  printf '0\n' >"$fixture_dir/poll"
  invoke 42 --me RestartDK --repo twin-so/cobb --interval 0 --until-closed
  assert_status 0 "deferred conflict to $outcome status"
  assert_eq "[\"CONFLICT\",\"CONFLICT\",\"$outcome\"]" "$(jq -sc '[.[].verdict]' <<<"$last_output")" "deferred blocker keeps cleanup watch armed"
done

printf 'watch-pr tests passed\n'
