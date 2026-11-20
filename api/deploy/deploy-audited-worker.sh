#!/usr/bin/env bash
# Prepared for the Linux VM; not executed against the hosted API.
# Run as the checkout owner: bash deploy-audited-worker.sh [actual RUNTIME_DIR]
# Updates only the audited worker, retaining a backup and rolling back on failure.
set -euo pipefail
service=practice-api
revision=9f7f646071c7747ab9cee9d7c5920e54e9293a61
base="https://raw.githubusercontent.com/influxtion/Pokemon-Showdown-Evolved/$revision/api"
api_dir=$(systemctl show "$service" --property=WorkingDirectory --value)
[[ "$api_dir" = /* && -f "$api_dir/worker/foulplay_worker.py" && -w "$api_dir/worker" ]] || {
  echo 'Run as the service checkout owner; its worker directory must be writable.' >&2; exit 1;
}
runtime_dir=${1:-"$api_dir/runtime"}
python="$runtime_dir/current/python/bin/python3"
source_dir="$runtime_dir/current/foul-play"
[[ -x "$python" && -d "$source_dir/fp" ]] || {
  echo 'Supply the service runtime directory as the first argument.' >&2; exit 1;
}
sudo -v
systemctl is-active --quiet "$service"
stage=$(mktemp -d "$api_dir/worker/.audit-stage.XXXXXXXX")
backup=''
restore=0
cleanup() {
  result=$?
  trap - EXIT
  if [[ "$restore" = 1 ]]; then
    echo 'Deployment failed; restoring previous worker.' >&2
    cp -p "$backup" "$stage/restore.py"
    mv -f "$stage/restore.py" "$api_dir/worker/foulplay_worker.py"
    sudo systemctl restart "$service" || true
  fi
  rm -rf -- "$stage"
  exit "$result"
}
trap cleanup EXIT
mkdir -p "$stage/api/worker" "$stage/api/test"
curl --fail --silent --show-error --location --max-time 60 "$base/worker/foulplay_worker.py" -o "$stage/api/worker/foulplay_worker.py"
curl --fail --silent --show-error --location --max-time 60 "$base/test/worker_test.py" -o "$stage/api/test/worker_test.py"
(
  cd "$stage/api"
  printf '%s\n' \
    'c355f179f7f98a95b05ec71e6e522ece02c396b818c2cec367e629813b6c21fc  worker/foulplay_worker.py' \
    '7602bae7102bab7cf0395775597a81ae0c7d67159523f7b45640f4c0e2bc8b4c  test/worker_test.py' | sha256sum --check
)
"$python" -I -B "$stage/api/test/worker_test.py"
for format in gen9randombattle gen9ou; do
  "$python" -I -B "$stage/api/worker/foulplay_worker.py" --source "$source_dir" --format "$format" --check
done
# Refuse to interrupt active games or players already waiting in the queue.
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8787/v1/info | node -e '
let data="";process.stdin.on("data", chunk=>data+=chunk);process.stdin.on("end",()=>{
  const c=JSON.parse(data).capacity;
  if (!c || c.active!==0 || c.waiting!==0) {console.error("API is busy; retry when idle.");process.exitCode=1;}
});'
backup=$(mktemp "$api_dir/worker/foulplay_worker.backup.XXXXXXXX.py")
cp -p "$api_dir/worker/foulplay_worker.py" "$backup"
restore=1
sudo systemctl stop "$service"
chmod --reference="$backup" "$stage/api/worker/foulplay_worker.py"
mv -f "$stage/api/worker/foulplay_worker.py" "$api_dir/worker/foulplay_worker.py"
sudo systemctl start "$service"
for attempt in {1..15}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8787/healthz | node -e '
let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}});'; then
    systemctl is-active --quiet "$service"
    restore=0
    printf 'Worker deployed from %s\nBackup retained: %s\n' "$revision" "$backup"
    sha256sum "$api_dir/worker/foulplay_worker.py"
    exit 0
  fi
  sleep 1
done
echo 'Health check failed.' >&2
exit 1
