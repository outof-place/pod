# Pod agent shells (POD_CLAUDE_OG=1, ../../claude-og.swift): the launcher points ZDOTDIR here for claude.
# Claude's snapshot `grep`/`find` run "$CLAUDE_CODE_EXECPATH", which Claude sets per Bash command:
# point it at pod-search-tool when it is the Claude build the launcher checked.
if [[ -n ${POD_SEARCH_TOOL:-} && -x $POD_SEARCH_TOOL && -n ${CLAUDE_CODE_EXECPATH:-} &&
  $CLAUDE_CODE_EXECPATH != "$POD_SEARCH_TOOL" && ${CLAUDE_CODE_EXECPATH:t} == "${POD_CLAUDE_OG_VERSION:-/}" ]]; then
  builtin export POD_CLAUDE_EXECPATH=$CLAUDE_CODE_EXECPATH CLAUDE_CODE_EXECPATH=$POD_SEARCH_TOOL
fi
# Why now: the user's startup files and every child see their own ZDOTDIR and BASH_ENV.
if [[ -n ${POD_ORIG_ZDOTDIR+x} ]]; then
  builtin export ZDOTDIR=$POD_ORIG_ZDOTDIR
  builtin unset POD_ORIG_ZDOTDIR
else
  builtin unset ZDOTDIR
fi
if [[ -n ${POD_ORIG_BASH_ENV+x} ]]; then
  builtin export BASH_ENV=$POD_ORIG_BASH_ENV
  builtin unset POD_ORIG_BASH_ENV
else
  builtin unset BASH_ENV
fi
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && builtin source ${ZDOTDIR:-$HOME}/.zshenv
