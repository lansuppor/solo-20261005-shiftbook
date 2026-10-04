const name: string = 'shiftbook';
const args: string[] = process.argv.slice(2);

if (args.length > 0 && !(args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.error(name + ': unknown arguments; use --help');
  process.exitCode = 2;
} else {
  console.log(name + '\n\nUsage: node app.ts [--help]\n\n场地资源预约与排班。当前仅提供帮助信息。');
}
