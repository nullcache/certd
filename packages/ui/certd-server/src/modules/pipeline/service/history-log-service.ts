import { Provide, Scope, ScopeEnum } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { BaseService } from '../../../basic/base-service.js';
import { HistoryLogEntity } from '../entity/history-log.js';

/**
 * 证书申请
 */
@Provide()
@Scope(ScopeEnum.Singleton)
export class HistoryLogService extends BaseService<HistoryLogEntity> {
  @InjectEntityModel(HistoryLogEntity)
  repository: Repository<HistoryLogEntity>;

  getRepository() {
    return this.repository;
  }

  async save(bean: HistoryLogEntity) {
    if (bean.id > 0) {
      await this.update(bean);
    } else {
      await this.add(bean);
    }
  }
}
