import { TurnContext } from 'botbuilder';
import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { SearchService } from './SearchService';
import { ConversationService } from './ConversationService';
import { OpenAIService } from './OpenAIService';
import mammoth from 'mammoth';
import fetch from 'cross-fetch';

interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export class CommandHandler {
    private graphClient: Client;
    private searchService: SearchService;
    private conversationService: ConversationService;
    private openAIService: OpenAIService;

    constructor(
        conversationService: ConversationService,
        searchService: SearchService,
        openAIService: OpenAIService
    ) {
        this.conversationService = conversationService;
        this.searchService = searchService;
        this.openAIService = openAIService;

        const credential = new ClientSecretCredential(
            process.env.AZURE_AD_TENANT_ID!,
            process.env.AZURE_AD_CLIENT_ID!,
            process.env.AZURE_AD_CLIENT_SECRET!
        );

        this.graphClient = Client.initWithMiddleware({
            authProvider: {
                getAccessToken: async () => {
                    const tokenResponse = await credential.getToken("https://graph.microsoft.com/.default");
                    return tokenResponse?.token || "";
                }
            }
        });
    }

    async handleCommand(context: TurnContext, command: string): Promise<void> {
        const args = command.split(" ");
        if (args[0] === '/checkSharePointFiles') {
            await this.checkSharePointFiles(context);
        } else if (args[0] === '/askDocument') {
            const question = args.slice(1).join(" ");
            await this.askQuestionFromDocument(context, question);
        } else {
            await context.sendActivity("Unknown command. Type /help for available commands.");
        }
    }

    private async checkSharePointFiles(context: TurnContext): Promise<void> {
        try {
            const [siteName, siteId, listId] = process.env.SHAREPOINT_SITE_ID!.split(',');
            const response = await this.graphClient
                .api(`/sites/${siteId}/lists/277aab70-d73e-4a9a-a9a9-975686c0aa30/drive/root/children`)
                .get();

            if (response.value && response.value.length > 0) {
                let fileList = response.value.map((file: any) => file.name).join(', ');
                await context.sendActivity(`Files retrieved from SharePoint: ${fileList}`);
            } else {
                await context.sendActivity('No files found in the SharePoint folder.');
            }
        } catch (error) {
            console.error("Error accessing SharePoint files:", error);
            await context.sendActivity("Failed to access SharePoint files. Please check the bot's permissions.");
        }
    }


    private async askQuestionFromDocument(context: TurnContext, question: string): Promise<void> {
        try {
            // Access the QnA folder in the Shared Documents library using the correct drive ID
            const response = await this.graphClient
                .api(`/drives/b!DsNJcuVFEkKHyN7uogy-O4wRfS80-olKk0eI9OlqkoFwq3onPteaSqmpl1aGwKow/root:/QnA:/children`)
                .get();
    
            // Find the 'QnA.docx' document within the 'QnA' folder
            const document = response.value.find((file: any) => file.name === 'QnA.docx');
    
            if (document) {
                const contentUrl = document['@microsoft.graph.downloadUrl'];
                const documentContent = await this.downloadContent(contentUrl);
    
                // Prepare the question with the document content for OpenAI
                const messages: ChatMessage[] = [
                    { role: "system", content: "You are a helpful assistant that answers questions based on the provided document content." },
                    { role: "user", content: `Document content: ${documentContent.slice(0, 7800)}...` },  // Truncate content if needed
                    { role: "user", content: `Question: ${question}` }
                ];
    
                const answer = await this.openAIService.getChatCompletion(messages);
                await context.sendActivity(`Answer: ${answer}`);
            } else {
                await context.sendActivity('No suitable document found in the SharePoint folder.');
            }
        } catch (error) {
            console.error("Error processing document and question:", error);
            await context.sendActivity("Failed to retrieve the document content or process the question.");
        }
    }
    
    private async downloadContent(contentUrl: string): Promise<string> {
        try {
            const response = await fetch(contentUrl);
    
            if (!response.ok) {
                throw new Error(`Failed to fetch document: ${response.statusText}`);
            }
    
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const result = await mammoth.extractRawText({ buffer });
            return result.value;
        } catch (error) {
            console.error("Error downloading or parsing document content:", error);
            throw new Error("Failed to download or parse document content.");
        }
    }
    
    
}
