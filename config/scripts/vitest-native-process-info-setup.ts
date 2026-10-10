/**
 * Why: a macOS checkout that built native/proc-info-darwin would otherwise answer process-table
 * reads from the real kernel and bypass every `ps`/`lsof` mock. Suites that test the addon load
 * it by path or inject it with setNativeProcessInfoForTests.
 */
process.env.ORCA_DISABLE_NATIVE_PROCESS_INFO = '1'
