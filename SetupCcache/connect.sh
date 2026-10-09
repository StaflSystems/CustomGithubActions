#!/usr/bin/env bash
# Points ccache at the shared store for this runner: the LAN store on self-hosted runners, the AWS
# store (through a local TLS tunnel) on GitHub-hosted ones.
#
# ccache's HTTP backend can't speak HTTPS, so on GitHub-hosted runners a ghostunnel client listens
# on localhost:8080 and forwards to the AWS store over TLS.
#
# Fails open: if the store can't be reached, the job warns and builds without it.
set -uo pipefail

GHOSTUNNEL_VERSION=v1.11.3
declare -A GHOSTUNNEL_SHA256=(
  [amd64]=70766f99d6fd439cdf7912161f08a7d66a587a7fc7a79c1bce7fa332aec6fc89
  [arm64]=04d5c1855eeab6b9ae5fbdda3158604db82f3978ebb5958e601c70817c453576
)
TUNNEL_PORT=8080

warn_and_skip() {
  echo "::warning title=ccache::$1 Building without the shared ccache store."
  echo "store=none" >> "$GITHUB_OUTPUT"
  exit 0
}

# Percent-encode for the user-info part of a URL.
urlencode() {
  local LC_ALL=C s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# Succeeds once something accepts TCP connections on host:port, within about 15 seconds.
wait_for_port() {
  for _ in $(seq 10); do
    # timeout: a firewall that drops packets would otherwise hang the connect for minutes.
    # shellcheck disable=SC2016 # $1 and $2 expand in the inner shell
    timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null && return 0
    sleep 0.5
  done
  return 1
}

start_tunnel() {
  local target="$1" arch bin
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) return 1 ;;
  esac
  command -v curl > /dev/null || return 1
  bin="$RUNNER_TEMP/ghostunnel"
  curl -fsSL -o "$bin" \
    "https://github.com/ghostunnel/ghostunnel/releases/download/$GHOSTUNNEL_VERSION/ghostunnel-linux-$arch" || return 1
  echo "${GHOSTUNNEL_SHA256[$arch]}  $bin" | sha256sum -c --quiet - || return 1
  chmod +x "$bin"
  # setsid and nohup keep the tunnel running after this step's shell exits; it ends with the job.
  # The server is checked against the system trust store; the store has no client certificate.
  nohup setsid "$bin" client --listen "localhost:$TUNNEL_PORT" --target "$target" \
    --disable-authentication > "$RUNNER_TEMP/ghostunnel.log" 2>&1 < /dev/null &
  wait_for_port localhost "$TUNNEL_PORT"
}

if [ "$RUNNER_ENVIRONMENT" = self-hosted ]; then
  store=lan url="$LAN_URL" password="$LAN_PASSWORD"
else
  store=aws url="$AWS_URL" password="$AWS_PASSWORD"
fi
[ -n "$url" ] && [ -n "$password" ] || warn_and_skip "No URL or password for the $store store."

scheme="${url%%://*}"
hostport="${url#*://}"
hostport="${hostport%%/*}"

if [ "$scheme" = https ]; then
  [[ "$hostport" == *:* ]] || hostport="$hostport:443"
  start_tunnel "$hostport" || warn_and_skip "Couldn't start the TLS tunnel to $hostport."
  endpoint="localhost:$TUNNEL_PORT"
else
  [[ "$hostport" == *:* ]] || hostport="$hostport:80"
  wait_for_port "${hostport%:*}" "${hostport##*:}" || warn_and_skip "Couldn't reach $hostport."
  endpoint="$hostport"
fi

encoded="$(urlencode "$password")"
echo "::add-mask::$encoded"
{
  # SECONDARY_STORAGE is ccache 4.4–4.6's name for remote_storage; 4.7 and later still accept it.
  echo "CCACHE_SECONDARY_STORAGE=http://ci:$encoded@$endpoint|layout=bazel|connect-timeout=1000"
  # ccache 4.7 and later skip the local cache, which starts empty in every job anyway.
  # Older versions ignore it.
  echo "CCACHE_REMOTE_ONLY=1"
  if [ "$WRITE_ONLY" = true ]; then
    echo "CCACHE_RECACHE=1"
  fi
} >> "$GITHUB_ENV"
echo "store=$store" >> "$GITHUB_OUTPUT"

mode="reads and writes"
[ "$WRITE_ONLY" = true ] && mode="writes only"
echo "::notice title=ccache::Using the $store store ($hostport), $mode."
