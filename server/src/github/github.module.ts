import { Global, Module } from '@nestjs/common';
import { GitHubAppService } from './github-app.service';
import { InstallationsService } from './installations.service';

@Global()
@Module({
  providers: [GitHubAppService, InstallationsService],
  exports: [GitHubAppService, InstallationsService],
})
export class GitHubModule {}
