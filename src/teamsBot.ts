import {
    TeamsActivityHandler,
    TurnContext,
    ActivityTypes,
    MessageFactory,
    CardFactory
} from 'botbuilder';
import { OpenAIService } from './services/OpenAIService';
import { StorageService } from './services/StorageService';
import { SearchService } from './services/SearchService';
import { FileHandler } from './handlers/FileHandler';
import { MessageHandler } from './handlers/MessageHandler';
import { ChatMessage } from './types/ChatTypes';
import * as winston from 'winston';
import { CommandHandler } from './services/CommandHandler';
import { ConversationService } from './services/ConversationService';

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

interface ConversationState {
    documents: { [key: string]: any };
    documentContext: boolean;
    lastQuestionTimestamp: number;
    contextExpiryTime: number;
    processedFiles: any[];
    messageHistory: ChatMessage[];
    feedbackPrompted: boolean;
}

export class TeamsBot extends TeamsActivityHandler {
    private openAIService: OpenAIService;
    private fileHandler: FileHandler;
    private messageHandler: MessageHandler;
    private commandHandler: CommandHandler;
    private conversationStates: Map<string, ConversationState>;
    private readonly CONTEXT_TIMEOUT = 30 * 60 * 1000; // 30 minutes

    constructor(
        openAIService: OpenAIService,
        storageService: StorageService,
        searchService: SearchService
    ) {
        super();
        this.openAIService = openAIService;
        this.fileHandler = new FileHandler(storageService);
        this.messageHandler = new MessageHandler(searchService, openAIService);
        this.commandHandler = new CommandHandler(new ConversationService(), searchService, openAIService); // Initialize CommandHandler
        this.conversationStates = new Map<string, ConversationState>();

        this.setupHandlers();
    }

    public async run(context: TurnContext): Promise<void> {
        try {
            await super.run(context);
            
            const conversationId = context.activity.conversation.id;
            const state = this.getConversationState(conversationId);

            if (context.activity.type === ActivityTypes.Message) {
                const text = context.activity.text?.trim() || '';
                
                if (text.startsWith('aHR0cHM6Ly9ncHRz')) {
                    await this.handleDocumentSelection(context, text);
                }
            }
        } catch (error) {
            logger.error('Error in onTurn:', error);
            await context.sendActivity('Sorry, I encountered an error.');
        }
    }

    private getConversationState(conversationId: string): ConversationState {
        let state = this.conversationStates.get(conversationId);
        if (!state) {
            state = {
                documents: {},
                documentContext: false,
                lastQuestionTimestamp: Date.now(),
                contextExpiryTime: Date.now() + this.CONTEXT_TIMEOUT,
                processedFiles: [],
                messageHistory: [],
                feedbackPrompted: false
            };
            this.conversationStates.set(conversationId, state);
        }
        return state;
    }
    private async handleMessage(context: TurnContext): Promise<void> {
        try {
            const conversationId = context.activity.conversation.id;
            logger.info(`Processing message in conversation: ${conversationId}`);
    
            let state = this.getConversationState(conversationId);
            const incomingText = context.activity.text?.trim() || '';
    
            logger.info(`Incoming message: ${incomingText}`);
    
            // Check if the message has already been processed
            if (state.messageHistory.some(message => message.content === incomingText)) {
                logger.info(`Duplicate message detected: ${incomingText}`);
                await context.sendActivity("It seems you already asked this question.");
                return;
            }
    
            if ((context.activity.attachments?.length ?? 0) > 0) {
                await this.fileHandler.handleFileUpload(context);
                return;
            }
    
            // Process the message
            await this.messageHandler.handleMessage(context);
            logger.info(`Message processed: ${incomingText}`);
    
            // Save the processed message in history
            state.messageHistory.push({ role: 'user', content: incomingText });
            this.conversationStates.set(conversationId, state);
            logger.info(`Message history updated for conversation: ${conversationId}`);
        } catch (error) {
            logger.error('Error in handleMessage:', error);
            await context.sendActivity('Sorry, I encountered an error processing your message.');
        }
    }
    private async handleDocumentSelection(context: TurnContext, documentId: string): Promise<void> {
        try {
            const document = await this.messageHandler.getDocumentContent(documentId);
            if (document) {
                logger.info('Raw Document Content:', document.content);

                const formattedContent = this.formatDocumentContent(document.content);
                logger.info('Formatted Content:', JSON.stringify(formattedContent, null, 2));

                await context.sendActivity(MessageFactory.text(formattedContent));
                
                const imageUrls = this.extractImageUrls(document.content);
                for (const imageUrl of imageUrls) {
                    const card = CardFactory.heroCard('', [imageUrl], [], { text: '' });
                    await context.sendActivity({ attachments: [card] });
                }
            } else {
                await context.sendActivity("Sorry, I couldn't retrieve that document.");
            }
        } catch (error) {
            logger.error('Error handling document selection:', error);
            await context.sendActivity('Sorry, there was an error retrieving the document.');
        }
    }

    private extractImageUrls(content: string): string[] {
        const imageUrls: string[] = [];
        const regex = /!\[.*?\]\((.*?)\)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
            imageUrls.push(match[1]);
        }
        return imageUrls;
    }

    private getSourceUrl(content: string): string | null {
        const regex = /Source URL:\s*(https?:\/\/[^\s]+)/;
        const match = content.match(regex);
        return match ? match[1] : null;
    }

    private formatDocumentContent(content: string): string {
        const sourceUrl = this.getSourceUrl(content);
        let formattedContent = '';
        
        if (sourceUrl) {
            formattedContent += `📄 Source Document: ${sourceUrl}\n\n`;
        }

        formattedContent += content
            .replace(/!\[(.*?)\]\(.*?\)/g, '')
            .replace(/([^\n]+?)\s*={3,}/g, '\n\n## $1\n\n')
            .replace(/^\s*(\d+)\.\s*(.+)/gm, '\n$1. $2')
            .replace(/^\s*[•*]\s*(.+)/gm, '\n• $1')
            .replace(/([a-z])\)\s+(.+)/g, '   • $2')
            .replace(/(\/[A-Za-z_]+\/[A-Za-z0-9\/.]+)/g, '\n```\n$1\n```\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return formattedContent;
    }

    private setupHandlers(): void {
        this.onMessage(async (context: TurnContext) => {
            try {
                await context.sendActivity({ type: 'typing' });

                if (context.activity.attachments && context.activity.attachments.length > 0) {
                    await this.fileHandler.handleFileUpload(context);
                } else if (context.activity.text?.startsWith('/')) {
                    await this.commandHandler.handleCommand(context, context.activity.text);
                } else {
                    await this.messageHandler.handleMessage(context);
                }
            } catch (error) {
                console.error('Error in message handler:', error);
                await context.sendActivity('I encountered an error processing your request.');
            }
        });

        this.onMembersAdded(async (context: TurnContext) => {
            const welcomeText = `👋 Hello! I'm your AI assistant for Teams. I can help you with:
            
            - Analyzing uploaded files
            - Answering questions
            - Processing commands
            Type /help to see available commands.`;

            for (const member of context.activity.membersAdded || []) {
                if (member.id !== context.activity.recipient.id) {
                    await context.sendActivity(welcomeText);
                }
            }
        });
    }
}