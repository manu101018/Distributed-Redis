export interface ParsedCommand {
    name: string; // uppercased, e.g. "GET", "SET"
    args: string[]; // everything after the command name
}