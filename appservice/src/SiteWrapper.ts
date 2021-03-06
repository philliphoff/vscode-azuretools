/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// tslint:disable-next-line:no-require-imports
import WebSiteManagementClient = require('azure-arm-website');
import { AppServicePlan, NameValuePair, Site, SiteConfigResource, SiteLogsConfig, SiteSourceControl, User } from 'azure-arm-website/lib/models';
import * as fs from 'fs';
import { BasicAuthenticationCredentials, HttpOperationResponse, ServiceClientCredentials, TokenCredentials, WebResource } from 'ms-rest';
import * as opn from 'opn';
import * as request from 'request';
import * as requestP from 'request-promise';
import * as git from 'simple-git/promise';
import { Readable } from 'stream';
import { setInterval } from 'timers';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, IActionContext, IAzureNode, IParsedError, parseError, TelemetryProperties, UserCancelledError } from 'vscode-azureextensionui';
import KuduClient from 'vscode-azurekudu';
import { DeployResult, LogEntry } from 'vscode-azurekudu/lib/models';
import TelemetryReporter from 'vscode-extension-telemetry';
import { DialogResponses } from './DialogResponses';
import { ArgumentError } from './errors';
import * as FileUtilities from './FileUtilities';
import { IFileResult } from './IFileResult';
import { ILogStream } from './ILogStream';
import { localize } from './localize';
import { nodeUtils } from './utils/nodeUtils';
import { randomUtils } from './utils/randomUtils';
import { uiUtils } from './utils/uiUtils';
import { IQuickPickItemWithData } from './wizard/IQuickPickItemWithData';

// Deployment sources supported by Web Apps
export enum ScmType {
    None = 'None', // default scmType
    LocalGit = 'LocalGit',
    GitHub = 'GitHub'
}

export class SiteWrapper {
    public readonly resourceGroup: string;
    public readonly location: string;
    public readonly name: string;
    public readonly slotName?: string;
    public readonly planResourceGroup: string;
    public readonly planName: string;
    public readonly id: string;
    public readonly defaultHostName: string;
    public readonly isFunctionApp: boolean;
    private readonly _gitUrl: string;

    constructor(site: Site) {
        const matches: RegExpMatchArray | null = site.serverFarmId.match(/\/subscriptions\/(.*)\/resourceGroups\/(.*)\/providers\/Microsoft.Web\/serverfarms\/(.*)/);
        if (!site.id || !site.name || !site.resourceGroup || !site.type || !site.defaultHostName || matches === null || matches.length < 4) {
            throw new ArgumentError(site);
        }

        const isSlot: boolean = site.type.toLowerCase() === 'microsoft.web/sites/slots';
        this.id = site.id;
        this.resourceGroup = site.resourceGroup;
        this.location = site.location;
        this.name = isSlot ? site.name.substring(0, site.name.lastIndexOf('/')) : site.name;
        this.slotName = isSlot ? site.name.substring(site.name.lastIndexOf('/') + 1) : undefined;
        // the scm url used for git repo is in index 1 of enabledHostNames, not 0
        this._gitUrl = `${site.enabledHostNames[1]}:443/${site.repositorySiteName}.git`;
        this.defaultHostName = site.defaultHostName;
        this.isFunctionApp = site.kind === 'functionapp';

        this.planResourceGroup = matches[2];
        this.planName = matches[3];
    }

    public get appName(): string {
        return this.name + (this.slotName ? `-${this.slotName}` : '');
    }

    public get kuduUrl(): string {
        return `https://${this.appName}.scm.azurewebsites.net`;
    }

    public async stop(client: WebSiteManagementClient): Promise<void> {
        if (this.slotName) {
            await client.webApps.stopSlot(this.resourceGroup, this.name, this.slotName);
        } else {
            await client.webApps.stop(this.resourceGroup, this.name);
        }
    }

    public async start(client: WebSiteManagementClient): Promise<void> {
        if (this.slotName) {
            await client.webApps.startSlot(this.resourceGroup, this.name, this.slotName);
        } else {
            await client.webApps.start(this.resourceGroup, this.name);
        }
    }

    public async getState(client: WebSiteManagementClient): Promise<string | undefined> {
        const currentSite: Site = this.slotName ?
            await client.webApps.getSlot(this.resourceGroup, this.name, this.slotName) :
            await client.webApps.get(this.resourceGroup, this.name);

        return currentSite.state;
    }

    public async getWebAppPublishCredential(client: WebSiteManagementClient): Promise<User> {
        return this.slotName ?
            await client.webApps.listPublishingCredentialsSlot(this.resourceGroup, this.name, this.slotName) :
            await client.webApps.listPublishingCredentials(this.resourceGroup, this.name);
    }

    public async getSiteConfig(client: WebSiteManagementClient): Promise<SiteConfigResource> {
        return this.slotName ?
            await client.webApps.getConfigurationSlot(this.resourceGroup, this.name, this.slotName) :
            await client.webApps.getConfiguration(this.resourceGroup, this.name);
    }

    public async updateConfiguration(client: WebSiteManagementClient, config: SiteConfigResource): Promise<SiteConfigResource> {
        return this.slotName ?
            await client.webApps.updateConfigurationSlot(this.resourceGroup, this.name, config, this.slotName) :
            await client.webApps.updateConfiguration(this.resourceGroup, this.name, config);
    }

    public async getLogsConfig(client: WebSiteManagementClient): Promise<SiteLogsConfig> {
        return this.slotName ?
            await client.webApps.getDiagnosticLogsConfigurationSlot(this.resourceGroup, this.name, this.slotName) :
            await client.webApps.getDiagnosticLogsConfiguration(this.resourceGroup, this.name);
    }

    public async updateLogsConfig(client: WebSiteManagementClient, config: SiteLogsConfig): Promise<SiteLogsConfig> {
        return this.slotName ?
            await client.webApps.updateDiagnosticLogsConfigSlot(this.resourceGroup, this.name, config, this.slotName) :
            await client.webApps.updateDiagnosticLogsConfig(this.resourceGroup, this.name, config);
    }

    public async getAppServicePlan(client: WebSiteManagementClient): Promise<AppServicePlan> {
        return await client.appServicePlans.get(this.planResourceGroup, this.planName);
    }

    public async updateSourceControl(client: WebSiteManagementClient, siteSourceControl: SiteSourceControl): Promise<SiteSourceControl> {
        return this.slotName ?
            await client.webApps.createOrUpdateSourceControlSlot(this.resourceGroup, this.name, siteSourceControl, this.slotName) :
            await client.webApps.createOrUpdateSourceControl(this.resourceGroup, this.name, siteSourceControl);
    }

    public async syncRepository(client: WebSiteManagementClient): Promise<void> {
        return this.slotName ?
            await client.webApps.syncRepositorySlot(this.resourceGroup, this.name, this.slotName) :
            await client.webApps.syncRepository(this.resourceGroup, this.name);
    }

    public async deleteSite(client: WebSiteManagementClient, outputChannel: vscode.OutputChannel): Promise<void> {
        const confirmMessage: string = localize('deleteConfirmation', 'Are you sure you want to delete "{0}"?', this.appName);
        if (await vscode.window.showWarningMessage(confirmMessage, DialogResponses.yes, DialogResponses.cancel) !== DialogResponses.yes) {
            throw new UserCancelledError();
        }

        let plan: AppServicePlan | undefined;
        let deletePlan: boolean = false;

        if (!this.slotName) {
            // API calls not necessary for deployment slots
            plan = await this.getAppServicePlan(client);
        }

        if (!this.slotName && plan.numberOfSites < 2) {
            const message: string = localize('deleteLastServicePlan', 'This is the last app in the App Service plan "{0}". Do you want to delete this App Service plan to prevent unexpected charges?', plan.name);
            const input: vscode.MessageItem | undefined = await vscode.window.showWarningMessage(message, DialogResponses.yes, DialogResponses.no, DialogResponses.cancel);
            if (input === undefined) {
                throw new UserCancelledError();
            } else {
                deletePlan = input === DialogResponses.yes;
            }
        }

        outputChannel.show();
        outputChannel.appendLine(localize('Deleting', 'Deleting "{0}"...', this.appName));
        if (this.slotName) {
            await client.webApps.deleteSlot(this.resourceGroup, this.name, this.slotName);
        } else {
            await client.webApps.deleteMethod(this.resourceGroup, this.name, { deleteEmptyServerFarm: deletePlan });
        }
        outputChannel.appendLine(localize('DeleteSucceeded', 'Successfully deleted "{0}".', this.appName));
    }

    public async deploy(fsPath: string, client: WebSiteManagementClient, outputChannel: vscode.OutputChannel, configurationSectionName: string, confirmDeployment: boolean = true, telemetryProperties?: TelemetryProperties): Promise<void> {
        const config: SiteConfigResource = await this.getSiteConfig(client);
        if (telemetryProperties) {
            try {
                telemetryProperties.sourceHash = randomUtils.getPseudononymousStringHash(fsPath);
                telemetryProperties.destHash = randomUtils.getPseudononymousStringHash(this.appName);
                telemetryProperties.scmType = config.scmType;
                telemetryProperties.isSlot = this.slotName ? 'true' : 'false';
                telemetryProperties.alwaysOn = config.alwaysOn ? 'true' : 'false';
                telemetryProperties.linuxFxVersion = config.linuxFxVersion;
                telemetryProperties.nodeVersion = config.nodeVersion;
                telemetryProperties.pythonVersion = config.pythonVersion;
                telemetryProperties.hasCors = config.cors ? 'true' : 'false';
                telemetryProperties.hasIpSecurityRestrictions = config.ipSecurityRestrictions && config.ipSecurityRestrictions.length > 0 ? 'true' : 'false';
                telemetryProperties.javaVersion = config.javaVersion;
                this.getState(client).then(
                    (state: string) => {
                        telemetryProperties.state = state;
                    },
                    () => {
                        // ignore
                    });
            } catch (error) {
                // Ignore
            }
        }

        switch (config.scmType) {
            case ScmType.LocalGit:
                await this.localGitDeploy(fsPath, client, outputChannel);
                break;
            case ScmType.GitHub:
                throw new Error(localize('gitHubConnected', '"{0}" is connected to a GitHub repository. Push to GitHub repository to deploy.', this.appName));
            default: //'None' or any other non-supported scmType
                await this.deployZip(fsPath, client, outputChannel, configurationSectionName, confirmDeployment, telemetryProperties);
                break;
        }

        const displayUrl: string = this.isFunctionApp ? '' : this.defaultHostName;
        outputChannel.appendLine(
            displayUrl ?
                localize('deployCompleteWithUrl', '>>>>>> Deployment to "{0}" completed: {1} <<<<<<', this.appName, `https://${displayUrl}`) :
                localize('deployComplete', '>>>>>> Deployment to "{0}" completed. <<<<<<', this.appName)
        );

        outputChannel.appendLine('');
    }

    public async isHttpLogsEnabled(client: WebSiteManagementClient): Promise<boolean> {
        const logsConfig: SiteLogsConfig = await this.getLogsConfig(client);
        return logsConfig.httpLogs && logsConfig.httpLogs.fileSystem && logsConfig.httpLogs.fileSystem.enabled;
    }

    public async enableHttpLogs(client: WebSiteManagementClient): Promise<SiteLogsConfig> {
        const logsConfig: SiteLogsConfig = {
            location: this.location,
            httpLogs: {
                fileSystem: {
                    enabled: true,
                    retentionInDays: 7,
                    retentionInMb: 35
                }
            }
        };

        return await this.updateLogsConfig(client, logsConfig);
    }

    public async getKuduClient(client: WebSiteManagementClient): Promise<KuduClient> {
        const user: User = await this.getWebAppPublishCredential(client);
        if (!user.publishingUserName || !user.publishingPassword) {
            throw new ArgumentError(user);
        }

        const cred: BasicAuthenticationCredentials = new BasicAuthenticationCredentials(user.publishingUserName, user.publishingPassword);

        return new KuduClient(cred, this.kuduUrl);
    }

    public async editScmType(node: IAzureNode, outputChannel: vscode.OutputChannel): Promise<string | undefined> {
        const client: WebSiteManagementClient = nodeUtils.getWebSiteClient(node);
        const config: SiteConfigResource = await this.getSiteConfig(client);
        const newScmType: string = await this.showScmPrompt(config.scmType);
        if (newScmType === ScmType.GitHub) {
            if (config.scmType !== ScmType.None) {
                // GitHub cannot be configured if there is an existing configuration source-- a limitation of Azure
                throw new Error(localize('configurationError', 'Configuration type must be set to "None" to connect to a GitHub repository.'));
            }
            await this.connectToGitHub(node, outputChannel);
        } else {
            await this.updateScmType(client, config, newScmType);
        }
        this.log(outputChannel, localize('deploymentSourceUpdated,', 'Deployment source has been updated to "{0}".', newScmType));
        // returns the updated scmType
        return newScmType;
    }

    /**
     * Starts the log-streaming service. Call 'dispose()' on the returned object when you want to stop the service.
     */
    public async startStreamingLogs(client: KuduClient, reporter: TelemetryReporter | undefined, outputChannel: vscode.OutputChannel, path: string = ''): Promise<ILogStream> {
        outputChannel.show();
        outputChannel.appendLine(localize('connectingToLogStream', 'Connecting to log stream...'));
        const httpRequest: WebResource = new WebResource();
        await signRequest(httpRequest, client.credentials);

        const requestApi: request.RequestAPI<request.Request, request.CoreOptions, {}> = request.defaults(httpRequest);
        const logStream: ILogStream = { dispose: undefined, isConnected: true };
        // Intentionally setting up a separate telemetry event and not awaiting the result here since log stream is a long-running action
        // tslint:disable-next-line:no-var-self
        const me: SiteWrapper = this;
        // tslint:disable-next-line:no-floating-promises
        callWithTelemetryAndErrorHandling('appService.streamingLogs', reporter, undefined, async function (this: IActionContext): Promise<void> {
            this.suppressErrorDisplay = true;
            let timerId: NodeJS.Timer | undefined;
            if (me.isFunctionApp) {
                // For Function Apps, we have to ping "/admin/host/status" every minute for logging to work
                // https://github.com/Microsoft/vscode-azurefunctions/issues/227
                await me.pingFunctionApp(client);
                timerId = setInterval(async () => await me.pingFunctionApp(client), 60 * 1000);
            }

            await new Promise((resolve: () => void, reject: (err: Error) => void): void => {
                const logsRequest: request.Request = requestApi(`${me.kuduUrl}/api/logstream/${path}`);
                logStream.dispose = (): void => {
                    logsRequest.removeAllListeners();
                    logsRequest.destroy();
                    outputChannel.show();
                    if (timerId) {
                        clearInterval(timerId);
                    }
                    outputChannel.appendLine(localize('logStreamDisconnected', 'Disconnected from log-streaming service.'));
                    logStream.isConnected = false;
                    resolve();
                };

                logsRequest.on('data', (chunk: Buffer | string) => {
                    outputChannel.appendLine(chunk.toString());
                }).on('error', (err: Error) => {
                    outputChannel.appendLine(localize('logStreamError', 'Error connecting to log-streaming service:'));
                    outputChannel.appendLine(parseError(err).message);
                    reject(err);
                }).on('complete', () => {
                    logStream.dispose();
                });
            });
        });

        return logStream;
    }

    public async pingFunctionApp(kuduClient: KuduClient): Promise<void> {
        const requestOptions: WebResource = new WebResource();
        const adminKey: string = await kuduClient.functionModel.getAdminToken();
        await signRequest(requestOptions, new TokenCredentials(adminKey));
        // tslint:disable-next-line:no-unsafe-any
        await requestP.get(`https://${this.defaultHostName}/admin/host/status`, requestOptions);
    }

    public async getFile(client: KuduClient, filePath: string): Promise<IFileResult> {
        // tslint:disable:no-unsafe-any
        // tslint:disable-next-line:no-any
        const response: any = (<any>await client.vfs.getItemWithHttpOperationResponse(filePath)).response;
        if (response && response.body && response.headers && response.headers.etag) {
            return { data: response.body, etag: response.headers.etag };
            // tslint:enable:no-unsafe-any
        } else {
            throw new Error(localize('failedToFindFile', 'Failed to find file with path "{0}".', filePath));
        }
    }

    /**
     * Returns the latest etag of the updated file
     */
    public async putFile(client: KuduClient, data: Readable | string, filePath: string, etag: string): Promise<string> {
        let stream: Readable;
        if (typeof data === 'string') {
            stream = new Readable();
            stream._read = function (_size: number): void {
                this.push(data);
                this.push(null);
            };
        } else {
            stream = data;
        }
        const result: HttpOperationResponse<{}> = await client.vfs.putItemWithHttpOperationResponse(stream, filePath, { customHeaders: { ['If-Match']: etag } });
        return <string>result.response.headers.etag;
    }

    private async deployZip(fsPath: string, client: WebSiteManagementClient, outputChannel: vscode.OutputChannel, configurationSectionName: string, confirmDeployment: boolean, telemetryProperties?: TelemetryProperties): Promise<void> {
        if (confirmDeployment) {
            const warning: string = localize('zipWarning', 'Are you sure you want to deploy to "{0}"? This will overwrite any previous deployment and cannot be undone.', this.appName);
            if (await vscode.window.showWarningMessage(warning, DialogResponses.yes, DialogResponses.cancel) !== DialogResponses.yes) {
                if (telemetryProperties) {
                    telemetryProperties.cancelStep = 'confirmDestructiveDeployment';
                }
                throw new UserCancelledError();
            }
        }

        outputChannel.show();
        const kuduClient: KuduClient = await this.getKuduClient(client);

        let zipFilePath: string;
        let createdZip: boolean = false;
        if (FileUtilities.getFileExtension(fsPath) === 'zip') {
            zipFilePath = fsPath;
        } else if (await FileUtilities.isDirectory(fsPath)) {
            createdZip = true;
            this.log(outputChannel, localize('zipCreate', 'Creating zip package...'));
            const zipDeployConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(configurationSectionName, vscode.Uri.file(fsPath));
            // tslint:disable-next-line:no-backbone-get-set-outside-model
            const globPattern: string = zipDeployConfig.get<string>('zipGlobPattern');
            // tslint:disable-next-line:no-backbone-get-set-outside-model
            const ignorePattern: string | string[] = zipDeployConfig.get<string | string[]>('zipIgnorePattern');

            zipFilePath = await FileUtilities.zipDirectory(fsPath, globPattern, ignorePattern);
        } else {
            throw new Error(localize('NotAZipError', 'Path specified is not a folder or a zip file'));
        }

        try {
            this.log(outputChannel, localize('deployStart', 'Starting deployment...'));
            await kuduClient.pushDeployment.zipPushDeploy(fs.createReadStream(zipFilePath), { isAsync: true });
            await this.waitForDeploymentToComplete(kuduClient, outputChannel);
        } catch (error) {
            // tslint:disable-next-line:no-unsafe-any
            if (error && error.response && error.response.body) {
                // Autorest doesn't support plain/text as a MIME type, so we have to get the error message from the response body ourselves
                // https://github.com/Azure/autorest/issues/1527
                // tslint:disable-next-line:no-unsafe-any
                throw new Error(error.response.body);
            } else {
                throw error;
            }
        } finally {
            if (createdZip) {
                await FileUtilities.deleteFile(zipFilePath);
            }
        }
    }

    private async localGitDeploy(fsPath: string, client: WebSiteManagementClient, outputChannel: vscode.OutputChannel): Promise<void> {
        const kuduClient: KuduClient = await this.getKuduClient(client);
        const pushReject: string = localize('localGitPush', 'Push rejected due to Git history diverging. Force push?');
        const publishCredentials: User = await this.getWebAppPublishCredential(client);

        // credentials for accessing Azure Remote Repo
        const username: string = publishCredentials.publishingUserName;
        const password: string = publishCredentials.publishingPassword;
        const remote: string = `https://${username}:${password}@${this._gitUrl}`;
        const localGit: git.SimpleGit = git(fsPath);
        try {
            const status: git.StatusResult = await localGit.status();
            if (status.files.length > 0) {
                const uncommit: string = localize('localGitUncommit', '{0} uncommitted change(s) in local repo "{1}"', status.files.length, fsPath);
                vscode.window.showWarningMessage(uncommit);
            }
            await localGit.push(remote, 'HEAD:master');
        } catch (err) {
            // tslint:disable-next-line:no-unsafe-any
            if (err.message.indexOf('spawn git ENOENT') >= 0) {
                await this.showInstallPrompt();
                return undefined;
            } else if (err.message.indexOf('error: failed to push') >= 0) { // tslint:disable-line:no-unsafe-any
                const input: vscode.MessageItem | undefined = await vscode.window.showErrorMessage(pushReject, DialogResponses.yes, DialogResponses.cancel);
                if (input === DialogResponses.yes) {
                    await (<(remote: string, branch: string, options: object) => Promise<void>>localGit.push)(remote, 'HEAD:master', { '-f': true });
                    // Ugly casting neccessary due to bug in simple-git. Issue filed:
                    // https://github.com/steveukx/git-js/issues/218
                } else {
                    throw new UserCancelledError();
                }
            } else {
                throw err;
            }
        }

        outputChannel.show();
        this.log(outputChannel, (localize('localGitDeploy', `Deploying Local Git repository to "${this.appName}"...`)));
        await this.waitForDeploymentToComplete(kuduClient, outputChannel);
    }

    private async getJsonRequest(url: string, requestOptions: WebResource, node: IAzureNode): Promise<Object[]> {
        // Reference for GitHub REST routes
        // https://developer.github.com/v3/
        // Note: blank after user implies look up authorized user
        try {
            // tslint:disable-next-line:no-unsafe-any
            const gitHubResponse: string = await requestP.get(url, <WebResource>requestOptions);
            return <Object[]>JSON.parse(gitHubResponse);
        } catch (error) {
            const parsedError: IParsedError = parseError(error);
            if (parsedError.message.indexOf('Bad credentials') > -1) {
                // the default error is just "Bad Credentials," which is an unhelpful error message
                const tokenExpired: string = localize('tokenExpired', 'Azure\'s GitHub token has expired.  Reauthorize in the Portal under "Deployment options."');
                const goToPortal: string = localize('goToPortal', 'Go to Portal');
                const input: string | undefined = await vscode.window.showErrorMessage(tokenExpired, goToPortal);
                if (input === goToPortal) {
                    node.openInPortal();
                    // https://github.com/Microsoft/vscode-azuretools/issues/78
                    throw new UserCancelledError();
                } else {
                    throw new UserCancelledError();
                }
            } else {
                throw error;
            }
        }
    }

    /**
     * @param label Property of JSON that will be used as the QuickPicks label
     * @param description Optional property of JSON that will be used as QuickPicks description
     * @param data Optional property of JSON that will be used as QuickPicks data saved as a NameValue pair
     */
    private createQuickPickFromJsons(jsons: Object[], label: string, description?: string, data?: string[]): IQuickPickItemWithData<{}>[] {
        const quickPicks: IQuickPickItemWithData<{}>[] = [];
        for (const json of jsons) {
            const dataValuePair: NameValuePair = {};

            if (!json[label]) {
                // skip this JSON if it doesn't have this label
                continue;
            }

            if (description && !json[description]) {
                // if the label exists, but the description does not, then description will just be left blank
                description = undefined;
            }

            if (data) {
                // construct value pair based off data labels provided
                for (const property of data) {
                    // required to construct first otherwise cannot use property as key name
                    dataValuePair[property] = json[property];
                }
            }

            quickPicks.push({
                label: <string>json[label],
                description: `${description ? json[description] : ''}`,
                data: dataValuePair
            });
        }

        return quickPicks;
    }

    private async showScmPrompt(currentScmType: string): Promise<string> {
        const placeHolder: string = localize('scmPrompt', 'Select a new source.');
        const currentSource: string = localize('currentSource', '(Current source)');
        const scmQuickPicks: vscode.QuickPickItem[] = [];
        // generate quickPicks to not include current type
        for (const scmQuickPick of Object.keys(ScmType)) {
            if (scmQuickPick === currentScmType) {
                // put the current source at the top of the list
                scmQuickPicks.unshift({ label: scmQuickPick, description: currentSource });
            } else {
                scmQuickPicks.push({ label: scmQuickPick, description: '' });
            }
        }

        const quickPick: vscode.QuickPickItem = await vscode.window.showQuickPick(scmQuickPicks, { placeHolder: placeHolder });
        if (quickPick === undefined || quickPick.description === currentSource) {
            // if the user clicks the current source, treat it as a cancel
            throw new UserCancelledError();
        } else {
            return quickPick.label;
        }
    }

    private async waitForDeploymentToComplete(kuduClient: KuduClient, outputChannel: vscode.OutputChannel, pollingInterval: number = 5000): Promise<void> {
        const alreadyDisplayedLogs: string[] = [];
        let nextTimeToDisplayWaitingLog: number = Date.now();
        let permanentId: string | undefined;
        let initialReceivedTime: Date | undefined;
        let deployment: DeployResult | undefined;

        // tslint:disable-next-line:no-constant-condition
        while (true) {
            [deployment, permanentId, initialReceivedTime] = await this.getLatestDeployment(kuduClient, permanentId, initialReceivedTime);

            if (deployment === undefined || !deployment.id) {
                throw new Error(localize('failedToFindDeployment', 'Failed to get status of deployment.'));
            }

            let logEntries: LogEntry[] = [];
            try {
                logEntries = <LogEntry[]>await kuduClient.deployment.getLogEntry(deployment.id);
            } catch (error) {
                // Swallow 404 errors for a deployment while its still in the "temp" phase
                // (We can't reliably get logs until the deployment has shifted to the "permanent" phase)
                // tslint:disable-next-line:no-unsafe-any
                if (!deployment.isTemp || !error || error.statusCode !== 404) {
                    throw error;
                }
            }

            const newLogEntries: LogEntry[] = logEntries.filter((newEntry: LogEntry) => !alreadyDisplayedLogs.some((oldId: string) => newEntry.id === oldId));
            if (newLogEntries.length === 0) {
                if (Date.now() > nextTimeToDisplayWaitingLog) {
                    this.log(outputChannel, localize('waitingForComand', 'Waiting for long running command to finish...'));
                    nextTimeToDisplayWaitingLog = Date.now() + 60 * 1000;
                }
            } else {
                for (const newEntry of newLogEntries) {
                    if (newEntry.id) {
                        alreadyDisplayedLogs.push(newEntry.id);
                        if (newEntry.message) {
                            this.log(outputChannel, newEntry.message, newEntry.logTime);
                        }

                        if (newEntry.detailsUrl) {
                            const entryDetails: LogEntry[] = await kuduClient.deployment.getLogEntryDetails(deployment.id, newEntry.id);
                            for (const entryDetail of entryDetails) {
                                if (entryDetail.message) {
                                    this.log(outputChannel, entryDetail.message, entryDetail.logTime);
                                }
                            }
                        }
                    }
                }
            }

            if (deployment.complete) {
                if (deployment.isTemp) {
                    // If the deployment completed without making it to the "permanent" phase, it must have failed
                    throw new Error(localize('deploymentFailed', 'Deployment to "{0}" failed. See output channel for more details.', this.appName));
                } else {
                    return;
                }
            } else {
                await new Promise((resolve: () => void): void => { setTimeout(resolve, pollingInterval); });
            }
        }
    }

    private async getLatestDeployment(kuduClient: KuduClient, permanentId: string | undefined, initialReceivedTime: Date | undefined): Promise<[DeployResult | undefined, string | undefined, Date | undefined]> {
        let deployment: DeployResult | undefined;
        if (permanentId) {
            // Use "permanentId" to find the deployment during its "permanent" phase
            deployment = await kuduClient.deployment.getResult(permanentId);
        } else if (initialReceivedTime) {
            // Use "initialReceivedTime" to find the deployment during its "temp" phase
            deployment = (await kuduClient.deployment.getDeployResults())
                .filter((deployResult: DeployResult) => deployResult.receivedTime && deployResult.receivedTime >= initialReceivedTime)
                .sort((a: DeployResult, b: DeployResult) => b.receivedTime.valueOf() - a.receivedTime.valueOf())
                .shift();
            if (deployment && !deployment.isTemp) {
                // Make note of the id once the deplyoment has shifted to the "permanent" phase, so that we can use that to find the deployment going forward
                permanentId = deployment.id;
            }
        } else {
            // Use "latest" to get the deployment before we know the "initialReceivedTime" or "permanentId"
            deployment = await kuduClient.deployment.getResult('latest');
            if (deployment && deployment.receivedTime) {
                // Make note of the initialReceivedTime, so that we can use that to find the deployment going forward
                initialReceivedTime = deployment.receivedTime;
            }
        }

        return [deployment, permanentId, initialReceivedTime];
    }

    private log(outputChannel: vscode.OutputChannel, message: string, date?: Date): void {
        date = date || new Date();
        outputChannel.appendLine(`${date.toLocaleTimeString()} ${this.appName}: ${message}`);
    }

    private async updateScmType(client: WebSiteManagementClient, config: SiteConfigResource, scmType: string): Promise<string | undefined> {
        config.scmType = scmType;
        // to update one property, a complete config file must be sent
        const newConfig: SiteConfigResource = await this.updateConfiguration(client, config);
        return newConfig.scmType;

    }

    private async showInstallPrompt(): Promise<void> {
        const installString: string = localize('Install', 'Install');
        const input: string | undefined = await vscode.window.showErrorMessage(localize('GitRequired', 'Git must be installed to use Local Git Deploy.'), installString);
        if (input === installString) {
            // tslint:disable-next-line:no-unsafe-any
            opn('https://git-scm.com/downloads');
        }
    }

    private async connectToGitHub(node: IAzureNode, outputChannel: vscode.OutputChannel): Promise<void> {

        type gitHubOrgData = { repos_url?: string };
        type gitHubReposData = { repos_url?: string, url?: string, html_url?: string };

        const client: WebSiteManagementClient = nodeUtils.getWebSiteClient(node);
        const requestOptions: WebResource = new WebResource();
        requestOptions.headers = { ['User-Agent']: 'vscode-azureappservice-extension' };
        const oAuth2Token: string = (await client.listSourceControls())[0].token;
        if (!oAuth2Token) {
            await this.showGitHubAuthPrompt();
            return;
        }

        await signRequest(requestOptions, new TokenCredentials(oAuth2Token));
        const gitHubUser: Object[] = await this.getJsonRequest('https://api.github.com/user', requestOptions, node);

        const gitHubOrgs: Object[] = await this.getJsonRequest('https://api.github.com/user/orgs', requestOptions, node);
        const orgQuickPicks: IQuickPickItemWithData<{}>[] = this.createQuickPickFromJsons([gitHubUser], 'login', undefined, ['repos_url']).concat(this.createQuickPickFromJsons(gitHubOrgs, 'login', undefined, ['repos_url']));
        const orgQuickPick: gitHubOrgData = (await uiUtils.showQuickPickWithData(orgQuickPicks, { placeHolder: 'Choose your organization.', ignoreFocusOut: true })).data;

        const gitHubRepos: Object[] = await this.getJsonRequest(orgQuickPick.repos_url, requestOptions, node);
        const repoQuickPicks: IQuickPickItemWithData<{}>[] = this.createQuickPickFromJsons(gitHubRepos, 'name', undefined, ['url', 'html_url']);
        const repoQuickPick: gitHubReposData = (await uiUtils.showQuickPickWithData(repoQuickPicks, { placeHolder: 'Choose project.', ignoreFocusOut: true })).data;

        const gitHubBranches: Object[] = await this.getJsonRequest(`${repoQuickPick.url}/branches`, requestOptions, node);
        const branchQuickPicks: IQuickPickItemWithData<{}>[] = this.createQuickPickFromJsons(gitHubBranches, 'name');
        const branchQuickPick: IQuickPickItemWithData<{}> = await uiUtils.showQuickPickWithData(branchQuickPicks, { placeHolder: 'Choose branch.', ignoreFocusOut: true });

        const siteSourceControl: SiteSourceControl = {
            location: this.location,
            repoUrl: repoQuickPick.html_url,
            branch: branchQuickPick.label,
            isManualIntegration: false,
            deploymentRollbackEnabled: true,
            isMercurial: false
        };

        this.log(outputChannel, `"${this.appName}" is being connected to the GitHub repo. This may take several minutes...`);
        try {
            await this.updateSourceControl(client, siteSourceControl);
        } catch (err) {
            try {
                // a resync will fix the first broken build
                // https://github.com/projectkudu/kudu/issues/2277
                await this.syncRepository(client);
            } catch (error) {
                const parsedError: IParsedError = parseError(error);
                // The portal returns 200, but is expecting a 204 which causes it to throw an error even after a successful sync
                if (parsedError.message.indexOf('"statusCode":200') === -1) {
                    throw error;
                }
            }
        }
    }

    private async showGitHubAuthPrompt(): Promise<void> {
        const learnMore: string = localize('learnMore', 'Learn More');
        const setupGithub: string = localize('setupGithub', 'You must give Azure access to your GitHub account.');
        const input: string | undefined = await vscode.window.showErrorMessage(setupGithub, learnMore);
        if (input === learnMore) {
            // tslint:disable-next-line:no-unsafe-any
            opn('https://aka.ms/B7g6sw');
        }
    }
}

async function signRequest(req: WebResource, cred: ServiceClientCredentials): Promise<void> {
    await new Promise((resolve: () => void, reject: (err: Error) => void): void => {
        cred.signRequest(req, (err: Error) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}
