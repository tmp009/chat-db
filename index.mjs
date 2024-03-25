import 'dotenv/config';
import inquirer from 'inquirer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';
import inquirerCommandPrompt from 'inquirer-command-prompt';

inquirerCommandPrompt.setConfig({
    history: {
        save: true,
        folder: 'history',
        limit: 9999,
        blacklist: ['!exit']
    }
})

inquirer.registerPrompt(
    'command',
    inquirerCommandPrompt
)

const maxRetries = process.env.OPENAI_RETRY || 3;
const openai = new OpenAI();
const statePath = 'state.json';
const commandPath = 'commands.json';

// Initialize state variables
let jsonState, jsonCmds, msgs = [];

async function main() {
    try {
        // Initialize state variables from files
        jsonState = JSON.parse(await readFileIfExists(statePath)) || { data: {} };
        jsonCmds = JSON.parse(await readFileIfExists(commandPath)) || {};

        await printHelpText();

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
    const cmdName = cmd[2]?.toLowerCase() || '';
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
                    console.log(`En tiedä mitä ${cmdName} tarkoittaa, kirjoita se minulle (mikäli et halua luoda komentoa, paina vain enter)`);

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

                await runOpenAI("pyydän: " + jsonCmds[cmdName] + cmdContent)
            }
        } catch (error) {
            if (!error.exceededRetries) {
                console.error(error)
            }
        }

    } else {
        try {
            await runOpenAI(input);
            saveState();

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
            await printHelpText();
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
    const parsedJson = JSON.parse(await getState());
    console.log(JSON.stringify(parsedJson, null, 4));
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
async function printHelpText() {
    // Read logo file and display
    const logo = await fs.readFile("logo.txt", 'utf-8');
    console.log(logo);

    const cmdHelp = [
        { command: 'commands', description: 'Lista luoduista komennoista' },
        { command: 'reset', description: 'Aloita uusi keskustelu siten, että kaikki tämän hetkinen tila ja kommennot siirretään uuteen keskusteluun.' },
        { command: 'new', description: 'Aloita uusi keskustelu ja poista kaikki syöte, mutta säilytä komennot. Eli !komennot jäävät, mutta henkilöt jne poistuvat.' },
        { command: 'clear', description: 'Aloita uusi keskustelu ja poista kaikki syöte ja komennot. Eli täydellinen tyhjennys kaikelle.' },
    ];

    console.log("Käytettävissä olevat komennot:\n");

    cmdHelp.forEach((cmd) => console.log(`!${cmd.command}: ${cmd.description}`));
}

// Get current state
async function getState() {
    const response = await runOpenAI('anna kaikki tila json-muodossa', { 'type': 'json_object' }, false);
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
async function runOpenAI(message, format = { 'type': 'text' }, stream = true) {
    let model = 'gpt-4-1106-preview'
    msgs.push({ role: 'user', content: message });

    const messages = [
        { role: 'system', content: 'Olet käsikirjoitusprosessin avustaja. Kirjaat ylös tietokantaasi tietoja käsikirjoituksen henkilöistä, tapahtumista, paikoista ja niin edelleen. Et unohda mitään ellei erikseen pyydetä poistamaan. Oletuksena olet vain kirjuri ja vastaat vain esimerkiksi "ok, henkilö Pekka lisättiin" kun olet kirjannut asian ylös. Jos sinua pyydetään generoimaan tekstiä, teet niin. Vastaa aina suomeksi.' },
        { role: 'system', content: 'json-tiedot säilytetään pääavaimella "data" jossa on json-olio, joka sisältää aina kaiken tiedon mitä olet tallentanut: henkilöt, tapahtumat, paikat ja niin edelleen. On erittäin tärkeää, että tässä json-oliossa on kaikki tieto mitä olet saanut.' },
        { role: 'system', content: 'tila JSON-muodossa: ' + JSON.stringify(jsonState) }
    ];


    if (format.type != 'json_object') {
        // model = 'gpt-4'
        messages.push({ role: 'system', content: 'Älä palauta dataa JSON-muodossa vaan antaa se aina tavallisina tekstinä' });
    }


    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const completion = await openai.chat.completions.create({
                messages: messages.concat(msgs),
                model: model,
                response_format: format,
                stream: stream
            });

            if (stream) {
                let response = "";
                for await (const chunk of completion) {
                    response += chunk.choices[0]?.delta?.content || ""
                    process.stdout.write(chunk.choices[0]?.delta?.content || "");
                }

                msgs.push({ role: 'assistant', content: response });

                return
            } else {
                msgs.push({ role: 'assistant', content: completion.choices[0].message.content });

                return completion.choices[0].message.content;
            }


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