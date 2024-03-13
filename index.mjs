import 'dotenv/config';

import inquirer from 'inquirer';
import { OpenAI } from 'openai';
import fs from 'fs/promises';

const maxRetries = process.env.OPENAI_RETRY || 4;
const openai = new OpenAI();
const statePath = 'state.json';
const commandPath = 'commands.json';

let jsonState = {data:{}};
let jsonCmds = {};
let msgs = [];

async function main() {
    try {
        await fs.access(statePath);
        jsonState = JSON.parse(await fs.readFile(statePath, 'utf-8'));

    } catch (error) {
        if (error.code === 'ENOENT') {

            await fs.writeFile(statePath, JSON.stringify({data:{}}));
        } else {
            console.error('An error occurred:', error);
        }
    }

    try {
        await fs.access(commandPath);
        jsonCmds = JSON.parse(await fs.readFile(commandPath, 'utf-8'));

    } catch (error) {
        if (error.code === 'ENOENT') {

            await fs.writeFile(commandPath, JSON.stringify({}));
        } else {
            console.error('An error occurred:', error);
        }
    }

    while (true) {
        const cmd = (await inquirer.prompt([{
            type:'input',
            name: 'cmd',
            prefix:'>',
            message: ' '
        }])).cmd.trim();

        if (cmd.length == 0) {
            continue
        } else if (cmd.startsWith('!!')) { // update command
            const cmdName = cmd.replace('!!', '')
            
            if (jsonCmds[cmdName]) {
                console.log(`Komento synopsis tarkoittaa nyt: "${jsonCmds[cmdName]}"\nAnna uusi määritelmä:\n`);

                const updateCmd = (await inquirer.prompt([{
                    type:'input',
                    name: 'cmd',
                    prefix:'$',
                    message: ' '
                }])).cmd.trim();

                if (updateCmd.length > 0) {
                    jsonCmds[cmdName] = updateCmd;
                    await fs.writeFile(commandPath, JSON.stringify(jsonCmds), {encoding:'utf-8'})
                    console.log(`Ok, komento !${cmdName} päivitetty`)
                }
            } else {
                console.log(`En löytää komenti ${cmdName}`)
            }
        } else if (cmd.startsWith('!')) { // run or create command
            const cmdName = cmd.replace('!', '')
            let response;

            switch (cmdName) {

                case 'exit':                    
                process.exit(0);
                break;

                case 'dump':                    
                    response = await runOpenAI('anna kaikki tila json-muodossa', {'type':'json_object'})
                    console.log(response)

                    break;

                case 'reset': // save current state and reset the chat                    
                    response = await runOpenAI('anna kaikki tila json-muodossa', {'type':'json_object'})
                    await fs.writeFile(statePath, response, {encoding:'utf-8'})
                    msgs = []
                    jsonState = response;

                    break;
            
                default:
                    if (jsonCmds[cmdName]) {
                        response = await runOpenAI("pyydän: " + jsonCmds[cmdName])
                        console.log(response)
                    } else {
                        console.log(`En tiedä mitä ${cmdName} tarkoittaa, kirjoita se minulle:`);

                        const newCmd = (await inquirer.prompt([{
                            type:'input',
                            name: 'cmd',
                            prefix:'$',
                            message: ' '
                        }])).cmd.trim();

                        if (newCmd.length > 0) {
                            jsonCmds[cmdName] = newCmd;
                            await fs.writeFile(commandPath, JSON.stringify(jsonCmds), {encoding:'utf-8'})
                            console.log(`Ok, komento !${cmdName} luotu`)
                        }
                    }
                    
                    break;
            }

        } else {
            const response = await runOpenAI(cmd)
    
            console.log(response);
        }
    }
}


async function runOpenAI(message, format={'type':'text'}) {
    msgs.push({role:'user', content:message});
            

    const messages = [
        {role:'system', content: 'Olet käsikirjoitusprosessin avustaja. Pidät yllä tietokantaa käsikirjoituksen henkilöistä, tapahtumista, paikoista. Esität tarkentavia kysymyksiä syötteisiin, älä oleta mitään tai kehittele ajatuksia jos ei pyydetä. Älä kysy tarkentavia kysymyksiä ellei erikseen pyydetä. Oletuksena vastaat vain "ok"'},
        {role:'system', content: 'json-tiedot säilytetään pääavaimella "data" jossa on json-olio, joka sisältä taulukkoa henkilöistä, tapahtumista, paikoista.'},
        {role:'system', content: 'tila JSON-muodossa: ' + JSON.stringify(jsonState)}
    ].concat(msgs)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const completion = await openai.chat.completions.create({
                messages: messages,
                model: 'gpt-4-1106-preview',
                response_format: format
            });

            msgs.push({role:'assistant', content:completion.choices[0].message.content})

            return completion.choices[0].message.content

        } catch (error) {
            if (attempt+1 >= maxRetries) {
                console.error("Failed to receive response from OpenAI!")
                console.error("Error: " + error.message)

                return ''
            } else {
                console.error("Failed to receive response from OpenAI! Retrying...")
            }
        }
    }
}

main()