// Import required modules
import 'dotenv/config';
import inquirer from 'inquirer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import inquirerCommandPrompt from 'inquirer-command-prompt';

inquirer.registerPrompt(
    'command',
    inquirerCommandPrompt
)

// Constants
const maxRetries = process.env.OPENAI_RETRY || 3;
const openai = new OpenAI();
const statePath = 'state.json';
const commandPath = 'commands.json';

// Initialize state variables
let jsonState, jsonCmds, msgs = [];

// Main function
async function main() {
    try {
        // Initialize state variables from files
        jsonState = JSON.parse(await readFileIfExists(statePath)) || { data: {} };
        jsonCmds = JSON.parse(await readFileIfExists(commandPath)) || {};

        // Read logo file and display
        const logo = await fs.readFile("logo.txt", 'utf-8');
        console.log(logo);

        // Command processing loop
        while (true) {
            // Prompt user for input
            console.log("");
            const input = (await inquirer.prompt([{ type: 'command', name: 'cmd', prefix: '>', message: ' ' }])).cmd.trim();
            // Process input command
            await processCommand(input);
        }
    } catch (error) {
        console.error('An error occurred:', error);
    }
}


// Read file if it exists, otherwise return null
async function readFileIfExists(filePath) {
    try {
        await fs.access(filePath);
        return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

// Process commands
async function processCommand(input) {
    const regex = /^(?:(!{1,2})([\p{L}\d_]+))?(?:\s+(.*))?/u;
    const cmd = input.match(regex);
    const cmdPrefix = cmd[1] || '';
    const cmdName = cmd[2] || '';
    const cmdContent = cmd[3] || '';

    if (input.length == 0) {
        return;
    } else if (cmdPrefix == '!!') { // update command
        if (jsonCmds[cmdName]) {
            console.log(`Komento '${cmdName}' tarkoittaa nyt: "${jsonCmds[cmdName]}"\nAnna uusi määritelmä:\n`);

            const updateCmd = (await inquirer.prompt([{
                type: 'command',
                name: 'updateCmd',
                prefix: '$',
                message: ' '
            }])).updateCmd.trim();

            if (updateCmd.length > 0) {
                jsonCmds[cmdName] = updateCmd;
                await fs.writeFile(commandPath, JSON.stringify(jsonCmds), { encoding: 'utf-8' })
                console.log(`Ok, komento !${cmdName} päivitetty`)
            }
        } else {
            console.log(`En löydä komentoa ${cmdName}`)
        }
    } else if (cmdPrefix == '!') { // run or create command
        let response;

        try {
            // run built-in commands first
            const builtRun = await processBuiltInCommand(cmdName);

            if (!builtRun) { // handle user commands
                if (!jsonCmds[cmdName]) {
                    console.log(`En tiedä mitä ${cmdName} tarkoittaa, kirjoita se minulle:`);

                    const newCmd = (await inquirer.prompt([{
                        type: 'command',
                        name: 'newCmd',
                        prefix: '$',
                        message: ' '
                    }])).newCmd.trim();

                    if (newCmd.length > 0) {
                        jsonCmds[cmdName] = newCmd;
                        await fs.writeFile(commandPath, JSON.stringify(jsonCmds), { encoding: 'utf-8' })
                        console.log(`Ok, komento !${cmdName} luotu, suoritetaan se samantien:`)
                    } else {
                        return
                    }
                }

                response = await runOpenAI("pyydän: " + jsonCmds[cmdName] + cmdContent)
                console.log(response)
            }
        } catch (error) {
            if (!error.exceededRetries) {
                console.error(error)
            }
        }

    } else {
        try {
            const response = await runOpenAI(input);
            await saveState();

            console.log(response);

        } catch (error) {
            if (!error.exceededRetries) {
                console.error(error)
            }
        }
    }
}

// Process built-in commands
async function processBuiltInCommand(cmdName) {
    switch (cmdName) {
        case 'exit':
            process.exit(0);
        case 'clear':
            await clearState();
            break;
        case 'new':
            await resetState();
            break;
        case 'commands':
            printUserCommands();
            break;
        case 'help':
            printHelpText();
            break;
        case 'dump':
            await dumpState();
            break;
        case 'save':
            await saveState();
            break;
        case 'reset':
            await resetChat();
            break;
        default:
            return false;
        }
        
    return true;
}

// Clear state
async function clearState() {
    await fs.writeFile(commandPath, JSON.stringify({}), { encoding: 'utf-8' });
    await saveState({ data: {} });
    jsonCmds = {};
    msgs = [];
    console.log('Ok. Kaikki luodut komennot ja tila ovat poistettu. Aloitetaan uusi viestiketju.');
}

// Reset state
async function resetState() {
    msgs = [];
    await saveState({ data: {} });
    console.log('Ok, tila on poistettu. Aloitetaan uusi viestiketju.');
}

// Dump state
async function dumpState() {
    const response = await getState();
    console.log(response);
}

// Reset chat
async function resetChat() {
    await saveState();
    msgs = [];
    console.log('Ok, aloitetaan uusi viestiketju.');
}

// Print user-defined commands
function printUserCommands() {
    const commands = Object.entries(jsonCmds);

    if (commands.length == 0) {
        console.log('Ei löydy mitään komentoja.');
    } else {
        console.log('Käyttäjän määrittelemät komennot:');
        for (const [name, description] of commands) {
            console.log(`${name}: ${description}`);
        }
    }
}

// Print help text
function printHelpText() {
    const cmdHelp = [
        { command: 'commands', description: 'Lista luoduista komennoista' },
        { command: 'reset', description: 'Aloita uusi keskustelu säilyttäen kaikki syöte' },
        { command: 'new', description: 'Aloita uusi keskustelu ja poista kaikki syöte, mutta säilytä komennot' },
        { command: 'clear', description: 'Aloita uusi keskustelu ja poista kaikki syöte ja komennot' },
        { command: 'exit', description: 'Sulje ohjelma' },
        { command: 'dump', description: 'Näytää tilan JSON-muodossa' },
        { command: 'save', description: 'Tallenna tila' }
    ];

    console.log("Käytettävissä olevat komennot:\n");

    cmdHelp.forEach((cmd) => console.log(`${cmd.command}: ${cmd.description}`));
}

// Get current state
async function getState() {
    const response = await runOpenAI('anna kaikki tila json-muodossa', { 'type': 'json_object' });
    return response;
}

// Save state to file
async function saveState(state = null) {
    if (!state) {
        jsonState = await getState();
    } else {
        jsonState = JSON.stringify(state);
    }
    await fs.writeFile(statePath, jsonState, { encoding: 'utf-8' });
}

// Run OpenAI API to generate response
async function runOpenAI(message, format = { 'type': 'text' }) {
    msgs.push({ role: 'user', content: message });

    const messages = [
        { role: 'system', content: 'Olet käsikirjoitusprosessin avustaja. Kirjaat ylös tietokantaasi tietoja käsikirjoituksen henkilöistä, tapahtumista, paikoista ja niin edelleen. Oletuksena olet vain kirjuri ja vastaat vain "ok". Ainoastaan jos esitetään kysymys tai sanotaan esimerkiksi "anna ehdotus" tai "keksi mitä sanoo" jne toimit tämän mukaan.' },
        { role: 'system', content: 'json-tiedot säilytetään pääavaimella "data" jossa on json-olio, joka sisältää taulukkoa henkilöistä, tapahtumista, paikoista, ja tarvittaessa muita tiedot.' },
        { role: 'system', content: 'tila JSON-muodossa: ' + JSON.stringify(jsonState) }
    ];

    if (!format.type['json_object']) {
        messages.push({ role: 'system', content: 'Älä palauta dataa JSON-muodossa vaan antaa se tavallisina tekstinä' });
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const completion = await openai.chat.completions.create({
                messages: messages.concat(msgs),
                model: 'gpt-4-1106-preview',
                response_format: format
            });

            msgs.push({ role: 'assistant', content: completion.choices[0].message.content });

            return completion.choices[0].message.content;

        } catch (error) {
            if (attempt + 1 >= maxRetries) {
                console.error("Failed to receive response from OpenAI!");
                console.error("Error: " + error.message);

                error.exceededRetries = true;
                throw error;
            } else {
                console.error("Failed to receive response from OpenAI! Retrying...");
            }
        }
    }
}

// Start the main function
main();