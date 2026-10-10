import Darwin

signal(SIGPIPE, SIG_IGN)
run(Array(CommandLine.arguments.dropFirst()))
