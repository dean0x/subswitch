mktemp() {
  if [ "$#" -eq 1 ] && [ "$1" = "-d" ]; then
    local release_qa_temp
    release_qa_temp="$(/usr/bin/mktemp -d "${RELEASE_QA_ROOT}/tmp/smoke.XXXXXXXX")" || return
    printf '%s\n' '{"name":"subswitch-smoke-fixture","version":"0.0.0","private":true}' > "${release_qa_temp}/package.json"
    printf '%s\n' "${release_qa_temp}"
  else
    echo "release QA only supports the smoke mktemp -d fixture" >&2
    return 2
  fi
}
