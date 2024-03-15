import 'dotenv/config';

import inquirer from 'inquirer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';

const maxRetries = process.env.OPENAI_RETRY || 3;
const openai = new OpenAI();
const statePath = 'state.json';
const commandPath = 'commands.json';

let jsonState = {data:{}};
let jsonCmds = {};
let msgs = [];

async function main() {
    try {
        await fs.access(statePath);
        jsonState = await fs.readFile(statePath, 'utf-8');
        JSON.parse(jsonState)

    } catch (error) {
        if (error.code === 'ENOENT') {

            await fs.writeFile(statePath, JSON.stringify({data:{}}));
        } else {
            console.error('An error occurred:', error);
        }
    }

    try {
        await fs.access(commandPath);
        jsonCmds = JSON.parse(await fs.readFile(commandPath, 'utf-8'))

    } catch (error) {
        if (error.code === 'ENOENT') {

            await fs.writeFile(commandPath, JSON.stringify({}));
        } else {
            console.error('An error occurred:', error);
        }
    }

    while (true) {
        const regex = /^(?:(!{1,2})([\p{L}\d_]+))?(?:\s+(.*))?/u;
        const input = (await inquirer.prompt([{
            type:'input',
            name: 'cmd',
            prefix:'>',
            message: ' '
        }])).cmd.trim();

        const cmd = input.match(regex);
        const cmdPrefix = cmd[1] || '';
        const cmdName = cmd[2] || '';
        const cmdContent = cmd[3] || '';

        if (input.length == 0) {
            continue
        } else if (cmdPrefix == '!!') { // update command           
            if (jsonCmds[cmdName]) {
                console.log(`Komento ${cmdName} tarkoittaa nyt: "${jsonCmds[cmdName]}"\nAnna uusi määritelmä:\n`);

                const updateCmd = (await inquirer.prompt([{
                    type: 'input',
                    name: 'cmd',
                    prefix: '$',
                    message: ' '
                }])).cmd.trim();

                if (updateCmd.length > 0) {
                    jsonCmds[cmdName] = updateCmd;
                    await fs.writeFile(commandPath, JSON.stringify(jsonCmds), { encoding:'utf-8' })
                    console.log(`Ok, komento !${cmdName} päivitetty`)
                }
            } else {
                console.log(`En löydä komentoa ${cmdName}`)
            }
        } else if (cmdPrefix == '!') { // run or create command
            let response;

            try {
                switch (cmdName) {
                    case 'exit':                    
                        process.exit(0);
    
                    case 'clear':
                        await fs.writeFile(commandPath, JSON.stringify({}), { encoding:'utf-8' });
                        await saveState({data:{}})
                        jsonCmds = {};
                        msgs = [];
    
                        console.log('Ok. Kaikki luodut kommento ja tila ovat poistettu. Aloitetaan uusi viestiketju.')
                        
                        break;
    
                    case 'new':
                        msgs = [];
                        await saveState({data:{}})
                        console.log('Ok, tila on poistettu. Aloitetaan uusi viestiketju.')
                        break;
    
                    case 'commands':
                        printUserCommands();
                        break;
    
                    case 'help':
                        printHelpText();
                        break;
    
                    case 'dump':                    
                        response = await getState();
                        console.log(response)
                        break;
    
                    case 'save':
                        await saveState();
                        console.log('Tila on tallenettu!')
                        break;
    
                    case 'reset': // save the current state and reset the chat                    
                        await saveState();  
                        msgs = []
                        console.log('Ok, aloitetaan uusi viestiketju.')
    
                        break;
                
                    default:
                        if (!jsonCmds[cmdName]) {
                            console.log(`En tiedä mitä ${cmdName} tarkoittaa, kirjoita se minulle:`);
    
                            const newCmd = (await inquirer.prompt([{
                                type: 'input',
                                name: 'cmd',
                                prefix: '$',
                                message: ' '
                            }])).cmd.trim();
    
                            if (newCmd.length > 0) {
                                jsonCmds[cmdName] = newCmd;
                                await fs.writeFile(commandPath, JSON.stringify(jsonCmds), { encoding:'utf-8' })
                                console.log(`Ok, komento !${cmdName} luotu.`)
                            } else {
                                break;
                            }
                        }
    
                        response = await runOpenAI("pyydän: " + jsonCmds[cmdName] + cmdContent)
                        console.log(response)
                        break;
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
}


async function runOpenAI(message, format = { 'type':'text' }) {
    msgs.push({ role:'user', content:message });
            
    const messages = [
        { role:'system', content: 'Olet käsikirjoitusprosessin avustaja. Pidät yllä tietokantaa käsikirjoituksen henkilöistä, tapahtumista, paikoista. Esität tarkentavia kysymyksiä syötteisiin, älä oleta mitään tai kehittele ajatuksia jos ei pyydetä. Älä kysy tarkentavia kysymyksiä ellei erikseen pyydetä. Oletuksena vastaat vain "ok" paitsi jos esitetään kysymystä' },
        { role:'system', content: 'json-tiedot säilytetään pääavaimella "data" jossa on json-olio, joka sisältä taulukkoa henkilöistä, tapahtumista, paikoista, ja tarvittaessa muita tiedot.' },
        { role:'system', content: 'tila JSON-muodossa: ' + jsonState }
    ]

    if (!format.type['json_object']) {
        messages.push({ role:'system', content: 'Älä palauta dataa JSON-muodossa vaan antaa se tavallisina tekstinä' })
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const completion = await openai.chat.completions.create({
                messages: messages.concat(msgs),
                model: 'gpt-4-1106-preview',
                response_format: format
            });

            msgs.push({ role:'assistant', content:completion.choices[0].message.content })

            return completion.choices[0].message.content

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

async function getState() {
    const response = await runOpenAI('anna kaikki tila json-muodossa', { 'type':'json_object' });
    return response;
}

async function saveState(state) {
    if (!state) {
        jsonState = await getState();
    } else {
        jsonState = JSON.stringify(state);
    }
    await fs.writeFile(statePath, jsonState, { encoding:'utf-8' });
}

function printHelpText() {
    const cmdHelp = [
        { command: 'exit', description: 'Sulje ohjelma' },
        { command: 'dump', description: 'Näytää tila JSON-muodossa' },
        { command: 'reset', description: 'Tallentaa tila ja aloittaa uuden viestiketju' },
        { command: 'save', description: 'Tallentaa tila' },
        { command: 'help', description: 'Näyttää aputeksti' },
        { command: 'new', description: 'Poistaa tila ja aloita uusi viestiketju' },
        { command: 'clear', description: 'Poistaa kaikki luodut komento ja tila ja aloita uusi viestiketju' },
        { command: 'commands', description: 'Lista kaikki itse luodut komentoja' }
    ].sort((a, b) => a.command.localeCompare(b.command))

    console.log("Scriptbot kommentot:\n")
    
    cmdHelp.forEach((cmd)=>console.log(`${cmd.command}: ${cmd.description}`))
}

function printUserCommands() {
    const commands = Object.entries(jsonCmds);

    if (commands.length == 0) {
        console.log('Ei löytyy mitään komentoja.')
    } else {
        for (const [name, description] of commands) {
            console.log(`${name}: ${description}`)
        }
    }
}

main()