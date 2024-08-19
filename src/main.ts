import { Adapter, AdapterOptions } from '@iobroker/adapter-core';
import {
    CommandService,
    IServiceConfig,
    GetStateService,
    IGetStateServiceConfig,
    UsrcfgCgiService,
    RelayDataInterpreter,
    GetStateCategory,
    GetStateData,
    GetStateDataSysInfo,
    GetStateDataObject,
    SetStateService,
} from 'procon-ip';

// Augment the adapter.config object with the actual types
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        interface AdapterConfig {
            controllerUrl: string;
            basicAuth: boolean;
            username: string;
            password: string;
            updateInterval: number;
            requestTimeout: number;
            errorTolerance: number;
        }
    }
}

class ProconIp extends Adapter {
    private _relayDataInterpreter!: RelayDataInterpreter;
    private _getStateService!: GetStateService;
    private _setStateService!: SetStateService;
    private _usrcfgCgiService!: UsrcfgCgiService;
    private _commandService!: CommandService;
    private _forceUpdate: number[];
    private _stateData: GetStateData;
    private _bootstrapped = false;
    private _objectStateFields = ['value', 'category', 'label', 'unit', 'displayValue', 'active'];
    private _timeout: NodeJS.Timeout | null = null;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({
            ...options,
            name: 'procon-ip',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this._forceUpdate = new Array<number>();
        this._stateData = new GetStateData();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        let connectionApproved = false;
        await this.setState('info.connection', false, true);

        if (this.config.controllerUrl.length < 1 || !ProconIp.isValidURL(this.config.controllerUrl)) {
            this.log.warn(`Invalid controller URL ('${this.config.controllerUrl}') supplied.`);
            return;
        }

        const serviceConfig = Object.defineProperties(Object.create(this.config), {
            baseUrl: {
                value: this.config.controllerUrl,
                writable: true,
            },
            timeout: {
                value: this.config.requestTimeout,
                writable: true,
            },
        }) as IServiceConfig;
        this._relayDataInterpreter = new RelayDataInterpreter(this.log);
        this._getStateService = new GetStateService(serviceConfig as IGetStateServiceConfig, this.log);
        this._setStateService = new SetStateService(serviceConfig, this.log);
        this._usrcfgCgiService = new UsrcfgCgiService(serviceConfig, this.log, this._getStateService,
            this._relayDataInterpreter);
        this._commandService = new CommandService(serviceConfig, this.log);

        this.log.debug(`GetStateService url: ${this._getStateService.url}`);
        this.log.debug(`UsrcfgCgiService url: ${this._usrcfgCgiService.url}`);

        await this._getStateService.update().then(async (data) => {
            this._stateData = data;

            // Set objects once on startup
            if (!this._bootstrapped) {
                this.log.debug(`Initially setting adapter objects`);
                await this.setSysInfoObjectsNotExists(data.sysInfo);
                await this.setStateDataObjectsNotExists(data.objects);
            }
        });

        this._timeout = setTimeout(() => {
            // Start the actual service
            this._getStateService.start(
                (data: GetStateData) => {
                    this.log.silly(`Start processing new GetState.csv`);
                    connectionApproved = true;

                    // Set sys info states
                    data.sysInfo.toArrayOfObjects().forEach((info) => {
                        // Only update when value has changed
                        if (!this._bootstrapped || info.value !== this._stateData.sysInfo[info.key]) {
                            this.log.debug(`Updating sys info state ${info.key}: ${info.value}`);
                            this.setStateAsync(
                                `${this.name}.${this.instance}.info.system.${info.key}`,
                                info.value.toString(),
                                true,
                            ).catch((e) => {
                                this.log.error(`Failed setting state for '${info.key}': ${e}`);
                            });
                        }
                    });

                    this.updateAdvancedSysInfoStates(data.sysInfo);

                    // Set actual sensor and actor/relay object states
                    data.objects.forEach((obj) => {
                        this.log.silly(
                            `Comparing previous and current value (${obj.displayValue}) for '${obj.label}' (${obj.category})`,
                        );
                        this.log.silly(
                            `this._stateData.getDataObject(obj.id).value: ${
                                this._stateData.getDataObject(obj.id).value
                            }`,
                        );
                        this.log.silly(`obj.value: ${obj.value}`);

                        // Only update when value has changed or update is forced (on state change)
                        const forceObjStateUpdate = this._forceUpdate.indexOf(obj.id);
                        if (
                            !this._bootstrapped ||
                            forceObjStateUpdate >= 0 ||
                            (this._stateData.getDataObject(obj.id) &&
                                this._stateData.getDataObject(obj.id).value != obj.value)
                        ) {
                            if (this._stateData.getDataObject(obj.id).label != obj.label) {
                                this.log.debug(`Updating label for '${obj.label}' (${obj.category})`);
                                this.updateObjectCommonName(obj).catch((e: unknown) => {
                                    if (e instanceof Error) {
                                        this.log.error(`Failed fixing label for '${obj.label}': ${e.message}`);
                                    } else {
                                        this.log.error(`Failed fixing label for '${obj.label}': ${String(e)}`);
                                    }
                                });
                            }
                            this.log.debug(`Updating value for '${obj.label}' (${obj.category})`);
                            this.setDataState(obj);
                            if (this._forceUpdate[forceObjStateUpdate]) {
                                this._forceUpdate.splice(forceObjStateUpdate, 1);
                            }
                        }
                    });

                    this.log.silly(`Updating data object for next comparison`);
                    this._stateData = data;
                    this._bootstrapped = true;
                    this.setState('info.connection', true, true).catch(() => {});
                },
                (e: unknown) => {
                    this.setState('info.connection', false, true).catch(() => {});
                    if (!connectionApproved) {
                        if (e instanceof Error) {
                            this.log.error(`Could not connect to the controller: ${e.message}`);
                        } else {
                            this.log.error(`Could not connect to the controller: ${String(e)}`);
                        }
                        this._getStateService?.stop();
                    }
                },
            );
        }, 300);

        this.subscribeStates(`${this.name}.${this.instance}.relays.*`);
        this.subscribeStates(`${this.name}.${this.instance}.externalRelays.*`);
    }

    // Is called when adapter shuts down - callback has to be called under any circumstances!
    private onUnload(callback: () => void): void {
        try {
            // Stop the service loop (this also handles the info.connection state)
            this._getStateService?.stop();
            this.setState('info.connection', false, true).catch(() => {});
        } catch (e: unknown) {
            this.log.error(`Failed to stop GetState service: ${String(e)}`);
        } finally {
            if (this._timeout) {
                clearTimeout(this._timeout);
            }
            callback();
        }
    }

    // Is called if a subscribed state changes
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
            return;
        }
        if (state.ack) {
            // The state is already acknowledged -> no need to change anything
            return;
        }

        if (id.endsWith('.auto')) {
            this.relayToggleAuto(id, state).catch((e) => {
                this.log.error(`Error on relay toggle (${id}): ${e}`);
            });
        } else if (id.endsWith('.onOff')) {
            this.relayToggleOnOff(id, state).catch((e) => {
                this.log.error(`Error on relay toggle (${id}): ${e}`);
            });
        } else if (id.endsWith('.dosageTimer')) {
            this.setDosageTimer(id, state).catch((e) => {
                this.log.error(`Error on manual dosage (${id}): ${e}`);
            });
        } else if (id.endsWith('.timer')) {
            this.setRelayTimer(id, state).catch((e) => {
                this.log.error(`Error on relay timer (${id}): ${e}`);
            });
        }
    }

    private async relayToggleAuto(objectId: string, state: ioBroker.State): Promise<number> {
        const onOffState = await this.getStateAsync(objectId.replace(/\.auto$/, '.onOff'));
        if (!onOffState) {
            throw new Error(`Cannot get onOff state to toggle '${objectId}'`);
        }

        const obj = await this.getObjectAsync(objectId);
        if (!obj) {
            throw new Error(`Cannot handle state change for non-existent object '${objectId}'`);
        }

        const getStateDataObject: GetStateDataObject = this._stateData.getDataObject(Number(obj.native.id));
        this._forceUpdate.push(getStateDataObject.id);
        try {
            if (state.val) {
                this.log.info(`Switching ${obj.native.label}: auto`);
                return this._usrcfgCgiService.setAuto(getStateDataObject);
            } else if (onOffState.val) {
                this.log.info(`Switching ${obj.native.label}: on`);
                return this._usrcfgCgiService.setOn(getStateDataObject);
            } else {
                this.log.info(`Switching ${obj.native.label}: off`);
                return this._usrcfgCgiService.setOff(getStateDataObject);
            }
        } catch (e: unknown) {
            if (e instanceof Error) {
                this.log.error(`Error on switching operation: ${e.message}`);
            } else {
                this.log.error(`Error on switching operation: ${String(e)}`);
            }

            return -1;
        }
    }

    private async relayToggleOnOff(objectId: string, state: ioBroker.State): Promise<void> {
        const obj = await this.getObjectAsync(objectId);
        if (!obj) {
            throw new Error(`Cannot handle state change for non-existent object '${objectId}'`);
        }

        const getStateDataObject: GetStateDataObject = this._stateData.getDataObject(Number(obj.native.id));
        this._forceUpdate.push(getStateDataObject.id);
        try {
            if (state.val) {
                this.log.info(`Switching ${obj.native.label}: on`);
                await this._usrcfgCgiService.setOn(getStateDataObject);
            } else {
                this.log.info(`Switching ${obj.native.label}: off`);
                await this._usrcfgCgiService.setOff(getStateDataObject);
            }
        } catch (e: unknown) {
            if (e instanceof Error) {
                this.log.error(`Error on switching operation: ${e.message}`);
            } else {
                this.log.error(`Error on switching operation: ${String(e)}`);
            }
        }
    }

    private async setDosageTimer(objectId: string, state: ioBroker.State): Promise<void> {
        const obj = await this.getObjectAsync(objectId);
        if (!obj) {
            throw new Error(`Cannot handle state change for non-existent object '${objectId}'`);
        }

        const getStateDataObject: GetStateDataObject = this._stateData.getDataObject(Number(obj.native.id));
        const relayId =
            getStateDataObject.categoryId + (getStateDataObject.category === String(GetStateCategory.EXTERNAL_RELAYS) ? 8 : 0);
        this._forceUpdate.push(getStateDataObject.id);
        try {
            const stateValNumber = state.val as number;
            if (relayId === this._stateData.getChlorineDosageControlId()) {
                await this._commandService.setChlorineDosage(stateValNumber);
            } else if (relayId === this._stateData.getPhMinusDosageControlId()) {
                await this._commandService.setPhMinusDosage(stateValNumber);
            } else if (relayId === this._stateData.getPhPlusDosageControlId()) {
                await this._commandService.setPhPlusDosage(stateValNumber);
            }
            this.log.info(`Setting dosage timer ${obj.native.label} for ${state.val} seconds`);
        } catch (e: unknown) {
            if (e instanceof Error) {
                this.log.error(`Error setting dosage timer: ${e.message}`);
            } else {
                this.log.error(`Error setting dosage timer: ${String(e)}`);
            }
        }
    }

    private async setRelayTimer(objectId: string, state: ioBroker.State): Promise<void> {
        const obj = await this.getObjectAsync(objectId);
        if (!obj) {
            throw new Error(`Cannot handle state change for non-existent object '${objectId}'`);
        }

        const getStateDataObject: GetStateDataObject = this._stateData.getDataObject(Number(obj.native.id));
        const relayId =
            getStateDataObject.categoryId + (getStateDataObject.category === String(GetStateCategory.EXTERNAL_RELAYS) ? 9 : 1);
        this._forceUpdate.push(getStateDataObject.id);
        try {
            const stateValNumber = state.val as number;
            await this._setStateService.setTimer(relayId, stateValNumber);
            this.log.info(`Setting timer for ${obj.native.label} to ${state.val} seconds`);
        } catch (e: unknown) {
            if (e instanceof Error) {
                this.log.error(`Error setting relay timer: ${e.message}`);
            } else {
                this.log.error(`Error setting relay timer: ${String(e)}`);
            }
        }
    }

    private updateAdvancedSysInfoStates(sysInfo: GetStateDataSysInfo): void {
        if (!this._bootstrapped || sysInfo.dosageControl !== this._stateData.sysInfo.dosageControl) {
            this.log.debug('Updating advanced sys info states');
            this.setStateAsync(
                `${this.name}.${this.instance}.info.system.phPlusDosageEnabled`,
                sysInfo.isPhPlusDosageEnabled(),
                true,
            ).catch((e) => {
                this.log.error(
                    `Failed setting state for '${this.name}.${this.instance}.info.system.phPlusDosageEnabled': ${e}`,
                );
            });
            this.setStateAsync(
                `${this.name}.${this.instance}.info.system.phMinusDosageEnabled`,
                sysInfo.isPhMinusDosageEnabled(),
                true,
            ).catch((e) => {
                this.log.error(
                    `Failed setting state for '${this.name}.${this.instance}.info.system.phMinusDosageEnabled': ${e}`,
                );
            });
            this.setStateAsync(
                `${this.name}.${this.instance}.info.system.chlorineDosageEnabled`,
                sysInfo.isChlorineDosageEnabled(),
                true,
            ).catch((e) => {
                this.log.error(
                    `Failed setting state for '${this.name}.${this.instance}.info.system.chlorineDosageEnabled': ${e}`,
                );
            });
            this.setStateAsync(
                `${this.name}.${this.instance}.info.system.electrolysis`,
                sysInfo.isElectrolysis(),
                true,
            ).catch((e) => {
                this.log.error(`Failed setting state for '${this.name}.${this.instance}.info.electrolysis': ${e}`);
            });
        }
    }

    private async setSysInfoObjectsNotExists(data: GetStateDataSysInfo): Promise<void> {
        await this.setObjectNotExists(`${this.name}.${this.instance}.info.system`, {
            type: 'channel',
            common: {
                name: 'SysInfo',
            },
            native: {},
        });
        for (const sysInfo of data.toArrayOfObjects()) {
            await this.setObjectNotExists(`${this.name}.${this.instance}.info.system.${sysInfo.key}`, {
                type: 'state',
                common: {
                    name: sysInfo.key,
                    type: 'string',
                    role: 'state',
                    read: true,
                    write: false,
                },
                native: {},
            });
        }

        await this.setObjectNotExists(`${this.name}.${this.instance}.info.system.phPlusDosageEnabled`, {
            type: 'state',
            common: {
                name: 'pH+ enabled',
                type: 'boolean',
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExists(`${this.name}.${this.instance}.info.system.phMinusDosageEnabled`, {
            type: 'state',
            common: {
                name: 'pH- enabled',
                type: 'boolean',
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExists(`${this.name}.${this.instance}.info.system.chlorineDosageEnabled`, {
            type: 'state',
            common: {
                name: 'CL enabled',
                type: 'boolean',
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.setObjectNotExists(`${this.name}.${this.instance}.info.system.electrolysis`, {
            type: 'state',
            common: {
                name: 'Electrolysis',
                type: 'boolean',
                role: 'state',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    private async setStateDataObjectsNotExists(objects: GetStateDataObject[]): Promise<void> {
        let lastObjCategory = '';
        for (const obj of objects) {
            if (lastObjCategory !== obj.category) {
                await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}`, {
                    type: 'channel',
                    common: {
                        name: obj.category,
                    },
                    native: {},
                });
                lastObjCategory = obj.category;
            }
            this.setDataObjectNotExists(obj).catch((e) => {
                this.log.error(`Failed setting objects for '${obj.label}': ${e}`);
            });
        }
    }

    private async setDataObjectNotExists(obj: GetStateDataObject): Promise<void> {
        await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}`, {
            type: 'channel',
            common: {
                name: obj.label,
            },
            native: {},
        });
        for (const field of Object.keys(obj)) {
            const common = {
                name: obj.label,
                type: typeof obj[field],
                role: 'value',
                read: true,
                write: false,
            } as ioBroker.StateCommon;

            switch (field) {
                case 'value':
                    if (obj.category == String(GetStateCategory.TEMPERATURES)) {
                        common.role = 'value.temperature';
                        common.unit = `°${obj.unit}`;
                        if (obj.active) {
                            common.smartName = {
                                de: obj.label,
                                en: obj.label,
                                smartType: 'THERMOSTAT',
                            };
                        }
                    }
                    break;
                case 'category':
                case 'label':
                case 'unit':
                case 'displayValue':
                    common.role = 'text';
                    break;
                case 'active':
                    common.role = 'indicator';
                    break;
                default:
                    continue;
            }

            try {
                await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.${field}`, {
                    type: 'state',
                    common: common,
                    native: obj,
                });
            } catch (e: unknown) {
                if (e instanceof Error) {
                    this.log.error(`Failed setting object '${obj.label}': ${e.message}`);
                } else {
                    this.log.error(`Failed setting object '${obj.label}': ${String(e)}`);
                }
            }
        }

        if (
            (obj.category as GetStateCategory) === GetStateCategory.RELAYS ||
            ((obj.category as GetStateCategory) === GetStateCategory.EXTERNAL_RELAYS &&
                this._stateData.sysInfo.isExtRelaysEnabled())
        ) {
            await this.setRelayDataObject(obj);
        }
    }

    private async setRelayDataObject(obj: GetStateDataObject): Promise<void> {
        const isLight = new RegExp('light|bulb|licht|leucht', 'i').test(obj.label);
        const relayId = (obj.category === String(GetStateCategory.EXTERNAL_RELAYS) ? 8 : 0) + obj.categoryId;
        const isDosageRelay = this._getStateService.data.isDosageControl(relayId);
        const commonAuto = {
            name: obj.label,
            type: 'boolean',
            role: 'switch.mode.auto',
            read: true,
            write: true,
            smartName: obj.active
                ? {
                      de: `${obj.label} auto`,
                      en: `${obj.label} auto`,
                      smartType: isLight ? 'LIGHT' : 'SWITCH',
                  }
                : {},
        } as ioBroker.StateCommon;
        const commonOnOff = {
            name: obj.label,
            type: 'boolean',
            role: isLight ? 'switch.light' : 'switch',
            read: true,
            write: !isDosageRelay,
            smartName:
                obj.active && !isDosageRelay
                    ? {
                          de: obj.label,
                          en: obj.label,
                          smartType: isLight ? 'LIGHT' : 'SWITCH',
                      }
                    : {},
        } as ioBroker.StateCommon;

        await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.auto`, {
            type: 'state',
            common: commonAuto,
            native: obj,
        });
        await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.onOff`, {
            type: 'state',
            common: commonOnOff,
            native: obj,
        });

        if (isDosageRelay) {
            const commonDosageTimerState = {
                name: obj.label,
                type: 'number',
                role: 'value.interval',
                read: false,
                write: true,
            } as ioBroker.StateCommon;

            await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.dosageTimer`, {
                type: 'state',
                common: commonDosageTimerState,
                native: obj,
            });
        } else {
            const commonGenericRelayTimerState = {
                name: obj.label,
                type: 'number',
                role: 'value.interval',
                read: false,
                write: true,
            } as ioBroker.StateCommon;

            await this.setObjectNotExists(`${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.timer`, {
                type: 'state',
                common: commonGenericRelayTimerState,
                native: obj,
            });
        }
    }

    private setDataState(obj: GetStateDataObject): void {
        for (const field of Object.keys(obj).filter((field) => this._objectStateFields.indexOf(field) > -1)) {
            this.setStateAsync(
                `${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.${field}`,
                obj[field] as ioBroker.StateValue,
                true,
            ).catch((e) => {
                this.log.error(`Failed setting state for '${obj.label}': ${e}`);
            });
        }

        if (
            (obj.category as GetStateCategory) === GetStateCategory.RELAYS ||
            ((obj.category as GetStateCategory) === GetStateCategory.EXTERNAL_RELAYS &&
                this._stateData.sysInfo.isExtRelaysEnabled())
        ) {
            this.setRelayDataState(obj);
        }
    }

    private setRelayDataState(obj: GetStateDataObject): void {
        this.setStateAsync(
            `${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.auto`,
            this._relayDataInterpreter.isAuto(obj),
            true,
        ).catch((e) => {
            this.log.error(`Failed setting auto/manual switch state for '${obj.label}': ${e}`);
        });
        this.setStateAsync(
            `${this.name}.${this.instance}.${obj.category}.${obj.categoryId}.onOff`,
            this._relayDataInterpreter.isOn(obj),
            true,
        ).catch((e) => {
            this.log.error(`Failed setting onOff switch state for '${obj.label}': ${e}`);
        });
    }

    private async updateObjectCommonName(obj: GetStateDataObject): Promise<void> {
        const objId = `${this.name}.${this.instance}.${obj.category}.${obj.categoryId}`;
        const ioObj = await this.getObjectAsync(objId);
        if (ioObj) {
            ioObj.common.name = obj.label;
            await this.setObject(objId, ioObj);
        }
        const objStates = await this.getStatesOfAsync(objId);
        if (objStates) {
            for (const state of objStates) {
                state.common.name = obj.label;
                await this.setObject(state._id, state);
            }
        }
    }

    private static isValidURL(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new ProconIp(options);
} else {
    // otherwise start the instance directly
    (() => new ProconIp())();
}
