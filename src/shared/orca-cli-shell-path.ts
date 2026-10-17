export const ORCA_CLI_POSIX_PATH_RESTORE = `if [ -n "\${POD_CLI_BIN_DIR:-}" ]; then
  case "\${PATH:-}" in
    "$POD_CLI_BIN_DIR"|"$POD_CLI_BIN_DIR":*) ;;
    *) export PATH="$POD_CLI_BIN_DIR\${PATH:+:$PATH}" ;;
  esac
fi`
