/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Subscription } from 'azure-arm-resource/lib/subscription/models';
// tslint:disable-next-line:no-require-imports
import WebSiteManagementClient = require('azure-arm-website');
import { IAzureNode } from 'vscode-azureextensionui';

export namespace nodeUtils {
    export function getWebSiteClient(node: IAzureNode): WebSiteManagementClient {
        const subscription: Subscription = node.subscription;
        return new WebSiteManagementClient(node.credentials, subscription.subscriptionId);
    }
}
