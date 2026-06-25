import { confirm as confirmPrompt, input, password } from '@inquirer/prompts';

export async function confirm(message: string): Promise<boolean> {
  return confirmPrompt({ default: false, message });
}

export async function askQuestion(message: string): Promise<string> {
  return input({ message });
}

/** Prompts for a secret, masking the typed characters. */
export async function askSecret(message: string): Promise<string> {
  return password({ mask: true, message });
}
